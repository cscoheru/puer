import { test } from "node:test";
import assert from "node:assert/strict";
import type { FeedCommentPreviewItem } from "./feed-comment-contract.ts";
import {
  FeedCommentController,
  buildFeedReplyReturnPath,
  createFeedCommentCardState,
  feedReplyIntent,
  feedCommentSubmitGate,
  flattenFeedCommentPreview,
  parseFeedCommentCreated,
  parseRetryAfter,
  reduceFeedCommentState,
  type FeedCommentAttempt,
  type FeedCommentCardState,
  type FeedCommentFetchInput,
} from "./feed-comment-state.ts";

const PARENT: FeedCommentPreviewItem = {
  id: "parent-1",
  articleId: "article-1",
  parentId: null,
  content: "原来的顶层评论",
  contentTruncated: false,
  status: "published",
  origin: "human",
  createdAt: "2026-11-18T00:00:00.000Z",
  author: { id: "author-1", username: "茶友", avatar: null, level: 1 },
};

function createdBody(attempt: FeedCommentAttempt, overrides: Record<string, unknown> = {}) {
  return {
    id: "child-1",
    articleId: attempt.articleId,
    parentId: attempt.parentId,
    content: attempt.content,
    images: [],
    status: "published",
    pendingReview: false,
    origin: "human",
    createdAt: "2026-11-18T01:00:00.000Z",
    author: { id: "user-1", username: "我", avatar: null, level: 2 },
    ...overrides,
  };
}

function problem(code: string, status = 400, requestId = "request-1") {
  return {
    type: `urn:puer:comment:${code}`,
    title: "title",
    detail: "safe detail",
    status,
    code,
    requestId,
    retryable: code === "comment.rate_limited",
    recovery: code === "comment.outcome_unknown" ? "detail" : "edit",
    sideEffects: code === "comment.outcome_unknown" ? "unknown" : "none",
    manualRetryLimit: code === "comment.rate_limited" ? 1 : 0,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function initial(count: number | null = 1) {
  return createFeedCommentCardState({
    instanceId: "instance-a",
    articleId: "article-1",
    currentUserId: "user-1",
    commentPreview: [PARENT],
    visibleReplyCount: count,
  });
}

function harness(options: {
  state?: FeedCommentCardState;
  fetcher: (input: FeedCommentFetchInput) => Promise<Response>;
  now?: () => number;
}) {
  const state = options.state ?? initial();
  let current = state;
  const watchdogs: Array<() => void> = [];
  const controller = new FeedCommentController(state, {
    fetcher: options.fetcher,
    now: options.now ?? (() => 10_000),
    requestId: (() => {
      let n = 0;
      return () => `request-${++n}`;
    })(),
    watchdog: (callback) => {
      watchdogs.push(callback);
      return () => {};
    },
    onChange: (next) => { current = next; },
  });
  controller.dispatch({ type: "open", parentId: "parent-1" });
  controller.dispatch({ type: "edit", parentId: "parent-1", text: "这是新的回复内容" });
  return {
    controller,
    state: () => current,
    fireWatchdog: (index = 0) => watchdogs[index](),
  };
}

test("parent switching and cancel preserve independent drafts and retry identity", () => {
  const h = harness({ fetcher: async () => { throw new Error("unused"); } });
  h.controller.dispatch({ type: "open", parentId: "parent-2" });
  h.controller.dispatch({ type: "edit", parentId: "parent-2", text: "另一个父评论的草稿" });
  h.controller.dispatch({ type: "open", parentId: "parent-1" });
  assert.equal(h.state().drafts["parent-1"].text, "这是新的回复内容");
  assert.equal(h.state().drafts["parent-2"].text, "另一个父评论的草稿");
  assert.notEqual(h.state().drafts["parent-1"].intentId, h.state().drafts["parent-2"].intentId);
  h.controller.dispatch({ type: "cancel" });
  h.controller.dispatch({ type: "open", parentId: "parent-2" });
  assert.equal(h.state().drafts["parent-2"].text, "另一个父评论的草稿");
});

test("synchronous attempt lock prevents double-click duplicate requests", async () => {
  const pending = deferred<Response>();
  let calls = 0;
  const h = harness({ fetcher: () => { calls++; return pending.promise; } });
  const first = h.controller.submit("parent-1");
  const second = h.controller.submit("parent-1");
  assert.equal(await second, false);
  assert.equal(calls, 1);
  const attempt = h.state().attempt!;
  pending.resolve(jsonResponse(201, createdBody(attempt)));
  assert.equal(await first, true);
  assert.equal(h.state().preview?.length, 2);
  assert.equal(h.state().visibleReplyCount, 2);
});

test("valid published and pending 201 append one real-parent child and count exactly once", async () => {
  for (const pending of [false, true]) {
    const h = harness({
      state: initial(null),
      fetcher: async ({ requestId }) => {
        const attempt = h.state().attempt!;
        assert.equal(requestId, attempt.requestId);
        return jsonResponse(201, createdBody(attempt, {
          id: pending ? "pending-1" : "published-1",
          status: pending ? "pending_review" : "published",
          pendingReview: pending,
        }));
      },
    });
    assert.equal(await h.controller.submit("parent-1"), true);
    const child = h.state().preview?.at(-1);
    assert.ok(child);
    assert.equal(child.parentId, "parent-1");
    assert.equal(child.status, pending ? "pending_review" : "published");
    assert.equal(h.state().visibleReplyCount, null);
    assert.equal(h.state().drafts["parent-1"], undefined);
    assert.equal(h.state().success?.pending, pending);
  }
});

test("known count increments once and a duplicate completion is ignored", () => {
  let state = initial(7);
  state = reduceFeedCommentState(state, { type: "open", parentId: "parent-1" });
  state = reduceFeedCommentState(state, { type: "edit", parentId: "parent-1", text: "这是新的回复内容" });
  state = reduceFeedCommentState(state, { type: "begin", parentId: "parent-1", requestId: "r1" });
  const attempt = state.attempt!;
  const body = createdBody(attempt);
  const comment = parseFeedCommentCreated(body, attempt, "user-1")!;
  state = reduceFeedCommentState(state, { type: "succeed", attempt, comment });
  state = reduceFeedCommentState(state, { type: "succeed", attempt, comment });
  assert.equal(state.visibleReplyCount, 8);
  assert.equal(state.preview?.length, 2);
});

test("watchdog invalidates a later valid 201 without clearing the draft or incrementing", async () => {
  const pending = deferred<Response>();
  const h = harness({ fetcher: () => pending.promise });
  const submission = h.controller.submit("parent-1");
  const attempt = h.state().attempt!;
  h.fireWatchdog();
  assert.equal(h.state().attempt, null);
  assert.equal(h.state().drafts["parent-1"].error?.code, "comment.outcome_unknown");
  pending.resolve(jsonResponse(201, createdBody(attempt)));
  assert.equal(await submission, false);
  assert.equal(h.state().visibleReplyCount, 1);
  assert.equal(h.state().preview?.length, 1);
  assert.equal(h.state().drafts["parent-1"].text, "这是新的回复内容");
});

test("old 201 cannot affect a newer attempt or its edited draft", async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  let calls = 0;
  const h = harness({ fetcher: () => (++calls === 1 ? first.promise : second.promise) });
  const firstSubmission = h.controller.submit("parent-1");
  const firstAttempt = h.state().attempt!;
  h.fireWatchdog(0);
  h.controller.dispatch({ type: "confirmAbsent", parentId: "parent-1" });
  h.controller.dispatch({ type: "edit", parentId: "parent-1", text: "这是修改后的新草稿" });
  const secondSubmission = h.controller.submit("parent-1");
  const secondAttempt = h.state().attempt!;
  assert.ok(secondAttempt.token > firstAttempt.token);
  first.resolve(jsonResponse(201, createdBody(firstAttempt)));
  assert.equal(await firstSubmission, false);
  assert.equal(h.state().attempt?.token, secondAttempt.token);
  assert.equal(h.state().drafts["parent-1"].text, "这是修改后的新草稿");
  second.resolve(jsonResponse(201, createdBody(secondAttempt)));
  assert.equal(await secondSubmission, true);
  assert.equal(h.state().preview?.at(-1)?.content, "这是修改后的新草稿");
});

test("StrictMode effect cleanup/setup replay restores dispatch without a render", () => {
  const h = harness({ fetcher: async () => { throw new Error("unused"); } });
  const rendered = h.state();
  h.controller.dispatch({ type: "unmount" });
  h.controller.mount();
  assert.equal(h.state(), rendered, "mount itself must not call React setState");
  h.controller.dispatch({ type: "open", parentId: "parent-2" });
  assert.equal(h.controller.getState().mounted, true);
  assert.equal(h.state().activeParentId, "parent-2");
});

test("unmount and a reordered component instance reject late success", async () => {
  const pending = deferred<Response>();
  const h = harness({ fetcher: () => pending.promise });
  const submission = h.controller.submit("parent-1");
  const attempt = h.state().attempt!;
  h.controller.dispatch({ type: "unmount" });
  pending.resolve(jsonResponse(201, createdBody(attempt)));
  assert.equal(await submission, false);
  const unmounted = h.controller.getState();
  assert.equal(unmounted.mounted, false);
  assert.equal(unmounted.visibleReplyCount, 1);
  assert.equal(unmounted.preview?.length, 1);

  const reordered = { ...initial(), instanceId: "instance-b" };
  const after = reduceFeedCommentState(reordered, {
    type: "succeed",
    attempt,
    comment: parseFeedCommentCreated(createdBody(attempt), attempt, "user-1")!,
  });
  assert.equal(after, reordered);
});

test("malformed and mismatched success schemas become unknown, never local success", async () => {
  const overrides = [
    { parentId: "other-parent" },
    { author: { id: "someone-else", username: "别人" } },
    { content: "different" },
    { images: ["not-empty"] },
    { status: "published", pendingReview: true },
    { createdAt: "not-a-date" },
  ];
  for (const override of overrides) {
    const h = harness({
      fetcher: async () => jsonResponse(201, createdBody(h.state().attempt!, override)),
    });
    assert.equal(await h.controller.submit("parent-1"), false);
    assert.equal(h.state().drafts["parent-1"].error?.code, "comment.outcome_unknown");
    assert.equal(h.state().visibleReplyCount, 1);
    assert.equal(h.state().preview?.length, 1);
    assert.ok(h.state().drafts["parent-1"].text);
  }
});

test("429 permits one timed manual retry and a repeated 429 is terminal", async () => {
  let calls = 0;
  let now = 1_000;
  const h = harness({
    now: () => now,
    fetcher: async (input) => {
      calls++;
      return jsonResponse(429, problem("comment.rate_limited", 429, input.requestId), { "Retry-After": "2" });
    },
  });
  await h.controller.submit("parent-1");
  assert.equal(h.state().drafts["parent-1"].error?.retryAfterSeconds, 2);
  assert.equal(feedCommentSubmitGate(h.state(), "parent-1", now).reason, "wait");
  now = 3_000;
  assert.equal(feedCommentSubmitGate(h.state(), "parent-1", now).ok, true);
  await h.controller.submit("parent-1");
  assert.equal(calls, 2);
  assert.equal(feedCommentSubmitGate(h.state(), "parent-1", now).reason, "terminal");
  assert.equal(await h.controller.submit("parent-1"), false);
  assert.equal(calls, 2);
  assert.ok(h.state().drafts["parent-1"].text);
});

test("editing text does not reset the rate-limit retry ledger", async () => {
  let calls = 0;
  const h = harness({
    fetcher: async (input) => {
      calls++;
      return jsonResponse(429, problem("comment.rate_limited", 429, input.requestId));
    },
  });
  await h.controller.submit("parent-1");
  h.controller.dispatch({ type: "edit", parentId: "parent-1", text: "编辑也不会重置额度" });
  await h.controller.submit("parent-1");
  h.controller.dispatch({ type: "edit", parentId: "parent-1", text: "再次编辑仍然不应解锁" });
  assert.equal(feedCommentSubmitGate(h.state(), "parent-1").reason, "terminal");
  assert.equal(calls, 2);
});

test("unknown requires confirmed absence for one retry, then becomes terminal", async () => {
  let calls = 0;
  const h = harness({
    fetcher: async () => {
      calls++;
      return jsonResponse(500, problem("comment.outcome_unknown", 500));
    },
  });
  await h.controller.submit("parent-1");
  assert.equal(feedCommentSubmitGate(h.state(), "parent-1").reason, "detail_check");
  h.controller.dispatch({ type: "confirmAbsent", parentId: "parent-1" });
  await h.controller.submit("parent-1");
  assert.equal(calls, 2);
  assert.equal(feedCommentSubmitGate(h.state(), "parent-1").reason, "terminal");
  h.controller.dispatch({ type: "confirmAbsent", parentId: "parent-1" });
  assert.equal(feedCommentSubmitGate(h.state(), "parent-1").reason, "terminal");
});

test("confirmed-present clears only the matching draft and never invents a count", () => {
  let state = initial(null);
  state = reduceFeedCommentState(state, { type: "open", parentId: "parent-1" });
  state = reduceFeedCommentState(state, { type: "edit", parentId: "parent-1", text: "这是新的回复内容" });
  state = reduceFeedCommentState(state, { type: "open", parentId: "parent-2" });
  state = reduceFeedCommentState(state, { type: "edit", parentId: "parent-2", text: "另一个草稿保留下来" });
  state = reduceFeedCommentState(state, { type: "open", parentId: "parent-1" });
  state = reduceFeedCommentState(state, { type: "begin", parentId: "parent-1", requestId: "r1" });
  const attempt = state.attempt!;
  state = reduceFeedCommentState(state, {
    type: "fail", attempt,
    error: { code: "comment.outcome_unknown", category: "network" },
  });
  state = reduceFeedCommentState(state, { type: "confirmPresent", parentId: "parent-1" });
  assert.equal(state.drafts["parent-1"], undefined);
  assert.equal(state.drafts["parent-2"].text, "另一个草稿保留下来");
  assert.equal(state.visibleReplyCount, null);
  assert.equal(state.preview?.length, 1);
});

test("parent conflict needs detail confirmation and only one fix-and-retry", async () => {
  let calls = 0;
  const h = harness({
    fetcher: async (input) => {
      calls++;
      return jsonResponse(409, problem("comment.parent_conflict", 409, input.requestId));
    },
  });
  await h.controller.submit("parent-1");
  assert.equal(feedCommentSubmitGate(h.state(), "parent-1").reason, "detail_check");
  h.controller.dispatch({ type: "confirmParentContext", parentId: "parent-1" });
  await h.controller.submit("parent-1");
  assert.equal(calls, 2);
  assert.equal(feedCommentSubmitGate(h.state(), "parent-1").reason, "terminal");
});

test("definite input errors require an edit, while 403 and gate-off remain non-retryable", async () => {
  for (const [code, status, editable] of [
    ["comment.invalid_input", 400, true],
    ["comment.moderation_rejected", 400, true],
    ["comment.forbidden", 403, false],
    ["comment.feed_disabled", 404, false],
  ] as const) {
    const h = harness({ fetcher: async () => jsonResponse(status, problem(code, status)) });
    await h.controller.submit("parent-1");
    assert.equal(feedCommentSubmitGate(h.state(), "parent-1").reason, editable ? "invalid" : "forbidden");
    h.controller.dispatch({ type: "edit", parentId: "parent-1", text: "修正以后的新内容" });
    assert.equal(feedCommentSubmitGate(h.state(), "parent-1").ok, editable);
  }
});

test("flattening keeps real parent IDs and gives every descendant one visual level", () => {
  const child = { ...PARENT, id: "child", parentId: "parent-1" };
  const grandchild = { ...PARENT, id: "grandchild", parentId: "child" };
  const rows = flattenFeedCommentPreview([PARENT, child, grandchild]);
  assert.deepEqual(rows.map(({ comment, nested }) => [comment.id, comment.parentId, nested]), [
    ["parent-1", null, false],
    ["child", "parent-1", true],
    ["grandchild", "child", true],
  ]);
});

test("login return keeps the current query, restricts reply intent and anchors the card", () => {
  const returned = buildFeedReplyReturnPath("/tw/forum", "tab=latest&feedReply=old", "article-1", "parent-1");
  assert.equal(returned, "/tw/forum?tab=latest&feedReply=parent-1&feedArticle=article-1#post-article-1");
  assert.deepEqual(feedReplyIntent(returned.split("?")[1].split("#")[0]), {
    articleId: "article-1", parentId: "parent-1",
  });
  assert.equal(buildFeedReplyReturnPath("//evil.example", "", "a", "p"), "/forum?feedArticle=a&feedReply=p#post-a");
});

test("Retry-After accepts numeric seconds or HTTP dates and rejects malformed values", () => {
  assert.deepEqual(parseRetryAfter("2.1", 1000), { retryAtMs: 3100, retryAfterSeconds: 3 });
  assert.deepEqual(parseRetryAfter("nonsense", 1000), {});
  const date = new Date(5000).toUTCString();
  assert.deepEqual(parseRetryAfter(date, 1000), { retryAtMs: 5000 });
});

test("editing text never clears a detail-check gate", () => {
  // Editing is not a detail check across two tabs. If a new revision unlocked
  // the retry, the user could republish a reply that already exists.
  for (const [code, category] of [
    ["comment.outcome_unknown", "network"],
    ["comment.parent_conflict", "http"],
  ] as const) {
    let state = initial(1);
    state = reduceFeedCommentState(state, { type: "open", parentId: "parent-1" });
    state = reduceFeedCommentState(state, { type: "edit", parentId: "parent-1", text: "这是新的回复内容" });
    state = reduceFeedCommentState(state, { type: "begin", parentId: "parent-1", requestId: "r1" });
    const attempt = state.attempt!;
    state = reduceFeedCommentState(state, { type: "fail", attempt, error: { code, category } });
    state = reduceFeedCommentState(state, { type: "edit", parentId: "parent-1", text: "编辑过的回复内容" });
    assert.equal(feedCommentSubmitGate(state, "parent-1").reason, "detail_check", code);
    // The error stays attached to the revision it belongs to, which is what the
    // UI's "edited since the error" branch keys on.
    assert.equal(state.drafts["parent-1"].error?.revision, attempt.revision, code);
  }
});

test("confirmPresent keeps text typed after the attempt and clears only the error", () => {
  let state = initial(null);
  state = reduceFeedCommentState(state, { type: "open", parentId: "parent-1" });
  state = reduceFeedCommentState(state, { type: "edit", parentId: "parent-1", text: "这是新的回复内容" });
  state = reduceFeedCommentState(state, { type: "begin", parentId: "parent-1", requestId: "r1" });
  const attempt = state.attempt!;
  state = reduceFeedCommentState(state, {
    type: "fail", attempt, error: { code: "comment.outcome_unknown", category: "network" },
  });
  state = reduceFeedCommentState(state, { type: "edit", parentId: "parent-1", text: "确认之后又写的第二段" });
  const after = reduceFeedCommentState(state, { type: "confirmPresent", parentId: "parent-1" });
  assert.equal(after.drafts["parent-1"].text, "确认之后又写的第二段", "unedited would be deleted; edited text is the user's");
  assert.equal(after.drafts["parent-1"].error, null);
  assert.equal(after.visibleReplyCount, null, "confirming never invents a count");
  assert.equal(after.preview?.length, 1, "confirming never invents a preview row");
  assert.equal(feedCommentSubmitGate(after, "parent-1").ok, true);
});

test("a spent manual retry stays terminal through every confirmation and edit", () => {
  let state = initial(1);
  state = reduceFeedCommentState(state, { type: "open", parentId: "parent-1" });
  state = reduceFeedCommentState(state, { type: "edit", parentId: "parent-1", text: "这是新的回复内容" });
  state = reduceFeedCommentState(state, { type: "begin", parentId: "parent-1", requestId: "r1" });
  state = reduceFeedCommentState(state, {
    type: "fail", attempt: state.attempt!, error: { code: "comment.outcome_unknown", category: "network" },
  });
  state = reduceFeedCommentState(state, { type: "confirmAbsent", parentId: "parent-1" });
  state = reduceFeedCommentState(state, { type: "begin", parentId: "parent-1", requestId: "r2" });
  state = reduceFeedCommentState(state, {
    type: "fail", attempt: state.attempt!, error: { code: "comment.outcome_unknown", category: "network" },
  });
  assert.equal(feedCommentSubmitGate(state, "parent-1").reason, "terminal");

  for (const action of [
    { type: "confirmAbsent", parentId: "parent-1" },
    { type: "confirmParentContext", parentId: "parent-1" },
    { type: "edit", parentId: "parent-1", text: "再编辑一次也不行" },
  ] as const) {
    state = reduceFeedCommentState(state, action);
    assert.equal(feedCommentSubmitGate(state, "parent-1").reason, "terminal", action.type);
  }
  assert.equal(state.drafts["parent-1"].text, "再编辑一次也不行", "the draft stays on screen so it can be copied");
});

test("a stale or mismatched 4xx is an unknown outcome, not a definite failure", async () => {
  // Each of these is a well-formed problem+json, yet none proves THIS attempt
  // failed: treating them as definite would reopen edit/retry and risk a
  // duplicate reply.
  for (const override of [
    { requestId: "request-from-another-attempt" },
    { status: 409 }, // body status disagrees with the HTTP status
    { sideEffects: "unknown" },
  ]) {
    const h = harness({
      fetcher: async (input) => jsonResponse(400, {
        ...problem("comment.invalid_input", 400, input.requestId),
        ...override,
      }),
    });
    assert.equal(await h.controller.submit("parent-1"), false);
    const draft = h.state().drafts["parent-1"];
    assert.equal(draft.error?.code, "comment.outcome_unknown");
    assert.equal(draft.text, "这是新的回复内容");
    // Unknown outcomes stay behind the detail reconciliation gate.
    assert.equal(feedCommentSubmitGate(h.state(), "parent-1").reason, "detail_check");
  }
});
