import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEED_COMMENT_ERROR_CODES,
  FEED_COMMENT_LIMITS,
  type FeedCommentProblem,
} from "./feed-comment-contract.ts";
import {
  FeedBodyError,
  feedLogCategory,
  feedProblem,
  feedRequestId,
  readFeedJsonBody,
  wantsFeedProblem,
} from "./comment-feed-errors.ts";
import { validateFeedCommentPayload } from "./comment-feed-write.ts";

const REQUEST_ID = "8b95a102-96b7-4ebf-9b2b-35c2601ef027";

function request(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1/api/comments", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    articleId: "article-1",
    content: "这是一条有效回复",
    parentId: "parent-1",
    images: [],
    surface: "feed",
    ...overrides,
  };
}

test("every stable code has an RFC 9457 shape and fixed safe diagnostics", async () => {
  for (const code of FEED_COMMENT_ERROR_CODES) {
    const response = feedProblem(code, REQUEST_ID);
    assert.match(response.headers.get("content-type")!, /application\/problem\+json/);
    assert.equal(response.headers.get("x-request-id"), REQUEST_ID);
    const body = await response.json() as FeedCommentProblem;
    assert.equal(body.code, code);
    assert.equal(body.status, response.status);
    assert.equal(body.requestId, REQUEST_ID);
    assert.match(body.type, /^urn:puer:comment:/);
    assert.equal(typeof body.title, "string");
    assert.equal(typeof body.detail, "string");
    assert.equal(typeof body.retryable, "boolean");
    assert.ok(body.recovery);
    assert.ok(body.sideEffects);
    assert.ok(body.manualRetryLimit === 0 || body.manualRetryLimit === 1);
    assert.equal(JSON.stringify(body).includes("stack"), false);
  }
});

test("unknown outcome declares unknown side effects; pre-create errors declare none", async () => {
  const unknown = await feedProblem("comment.outcome_unknown", REQUEST_ID).json() as FeedCommentProblem;
  const invalid = await feedProblem("comment.invalid_input", REQUEST_ID).json() as FeedCommentProblem;
  assert.equal(unknown.sideEffects, "unknown");
  assert.equal(unknown.recovery, "detail");
  assert.equal(invalid.sideEffects, "none");
  assert.equal(invalid.manualRetryLimit, 0);
});

test("rate limit exposes Retry-After only when supplied", async () => {
  const limited = feedProblem("comment.rate_limited", REQUEST_ID, { retryAfterSeconds: 2.1 });
  assert.equal(limited.headers.get("retry-after"), "3");
  assert.equal(feedProblem("comment.forbidden", REQUEST_ID).headers.has("retry-after"), false);
});

test("request ID accepts only a valid UUID and is never an idempotency key", () => {
  const echoed = request(null, { "X-Request-ID": REQUEST_ID });
  assert.equal(feedRequestId(echoed), REQUEST_ID);
  const generated = feedRequestId(request(null, { "X-Request-ID": "not-a-uuid" }));
  assert.match(generated, /^[0-9a-f-]{36}$/);
  assert.notEqual(generated, "not-a-uuid");
  assert.equal(wantsFeedProblem(request(null, { Accept: "application/problem+json" })), true);
  assert.equal(wantsFeedProblem(request(null, { Accept: "application/json" })), false);
});

test("stream parser accepts an exact 16 KiB JSON body", async () => {
  const text = "a".repeat(FEED_COMMENT_LIMITS.maxBodyBytes - 2);
  const body = JSON.stringify(text);
  assert.equal(Buffer.byteLength(body), FEED_COMMENT_LIMITS.maxBodyBytes);
  assert.equal(await readFeedJsonBody(request(body)), text);
});

test("chunked body over 16 KiB is rejected even with a false Content-Length", async () => {
  const bytes = new TextEncoder().encode("a".repeat(FEED_COMMENT_LIMITS.maxBodyBytes + 1));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 100));
      controller.enqueue(bytes.subarray(100));
      controller.close();
    },
  });
  await assert.rejects(
    readFeedJsonBody(request(stream, { "Content-Length": "100" })),
    (error: unknown) => error instanceof FeedBodyError && error.status === 413 && error.code === "comment.invalid_input",
  );
});

test("declared oversized body is rejected before reading", async () => {
  await assert.rejects(
    readFeedJsonBody(request("{}", { "Content-Length": "999999" })),
    (error: unknown) => error instanceof FeedBodyError && error.status === 413,
  );
});

test("an oversized clone probe settles instead of hanging the request", async () => {
  // The gate-off POST probes `req.clone()` before auth to learn whether the body
  // is a feed write. `clone()` tees the body, and a tee branch's `cancel()`
  // promise only settles once *both* branches are cancelled — so awaiting it
  // hangs the handler forever while the original body is still unread.
  const payload = JSON.stringify({
    surface: "feed",
    pad: "x".repeat(FEED_COMMENT_LIMITS.maxBodyBytes),
  });
  const bytes = new TextEncoder().encode(payload);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 64));
      controller.enqueue(bytes.subarray(64));
      controller.close();
    },
  });
  const original = request(stream);
  const probe = original.clone();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    readFeedJsonBody(probe).then(() => "resolved", () => "rejected"),
    new Promise<string>((resolve) => { timer = setTimeout(() => resolve("hung"), 2_000); }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(settled, "rejected", "the bounded probe must fail fast, not hang");

  // The legacy detail path still has to parse the real body afterwards.
  const parsed = JSON.parse(await original.text()) as { surface?: string; pad?: string };
  assert.equal(parsed.surface, "feed");
  assert.equal(parsed.pad?.length, FEED_COMMENT_LIMITS.maxBodyBytes);
});

test("malformed, truncated and invalid UTF-8 JSON are definite invalid_json errors", async () => {
  for (const body of ["{", '{"articleId":"a"', "not-json"]) {
    await assert.rejects(
      readFeedJsonBody(request(body)),
      (error: unknown) => error instanceof FeedBodyError && error.code === "comment.invalid_json",
    );
  }
  await assert.rejects(
    readFeedJsonBody(request(new Uint8Array([0xc3, 0x28]))),
    (error: unknown) => error instanceof FeedBodyError && error.code === "comment.invalid_json",
  );
});

test("feed validator enforces article-only, plain text, empty media and a real required parent", () => {
  const valid = validateFeedCommentPayload(validBody());
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.value.content, "这是一条有效回复");
    assert.equal(valid.value.parentId, "parent-1");
  }

  const { parentId: _omitted, ...withoutParent } = validBody();
  for (const body of [
    validBody({ tastingNoteId: "note-1" }),
    validBody({ articleId: "" }),
    validBody({ articleId: 42 }),
    validBody({ images: ["https://example.invalid/a.jpg"] }),
    // The feed card has no root composer: `null` is not "a root", it is invalid.
    validBody({ parentId: null }),
    validBody({ parentId: "" }),
    validBody({ parentId: "   " }),
    validBody({ parentId: 42 }),
    withoutParent,
    validBody({ surface: "detail" }),
    validBody({ content: 42 }),
  ]) {
    const result = validateFeedCommentPayload(body);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "comment.invalid_input");
  }
});

test("statement timeouts wrapped by Prisma P2010 stay classified as timeouts", () => {
  // Prisma surfaces a raw-SQL driver error as P2010 with the SQLSTATE under meta.
  assert.equal(feedLogCategory({
    code: "P2010",
    meta: { code: "57014", message: "canceling statement due to statement timeout" },
  }), "statement_timeout");
  assert.equal(feedLogCategory({
    code: "P2010",
    message: "Raw query failed. Code: `57014`. Message: `canceling statement due to statement timeout`",
  }), "statement_timeout");
  assert.equal(feedLogCategory({ code: "P2028" }), "transaction_timeout");
  assert.equal(feedLogCategory(new Error("boom")), "internal_error");
});

test("feed validator reports UTF-16 units and trims before bounds", () => {
  const trimmed = validateFeedCommentPayload(validBody({ content: "  茶茶茶茶茶  " }));
  assert.equal(trimmed.ok, true);
  if (trimmed.ok) assert.equal(trimmed.value.content, "茶茶茶茶茶");

  const tooLong = validateFeedCommentPayload(validBody({ content: "🍵".repeat(1001) }));
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) {
    assert.deepEqual(tooLong.context, {
      field: "content", unit: "utf16_code_units", limit: 2000, actual: 2002,
    });
  }
});
