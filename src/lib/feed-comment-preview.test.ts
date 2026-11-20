import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  feedCommentCandidatesSql,
  feedCommentErrorCategory,
  feedVisibleCountsSql,
  loadFeedCommentBatch,
  selectFeedCommentPreviews,
  type CandidateRow,
} from "./feed-comment-preview.ts";
import { parseSettingFlag, isFeedAiRepliesEnabled, invalidateSiteSettingCache, SITE_SETTING_KEYS } from "./site-settings.ts";
import { prisma } from "./prisma.ts";

let sequence = 0;
function candidate(articleId: string, kind: 0 | 1, createdAt: string, id?: string): CandidateRow {
  sequence += 1;
  return {
    id: id ?? `comment-${sequence}`,
    articleId,
    parentId: null,
    content: "a".repeat(1024),
    contentTruncated: false,
    status: "published",
    origin: kind === 0 ? "human" : "ai_autonomous",
    createdAt: new Date(createdAt),
    kind,
    authorId: `author-${sequence}`,
    username: `author-${sequence}`,
    avatar: null,
    level: 1,
  };
}

test("latest two humans are selected, AI never fills a mixed thread, display is oldest-first", () => {
  const rows = [
    candidate("a", 0, "2026-01-01T00:00:00Z", "old"),
    candidate("a", 0, "2026-01-03T00:00:00Z", "new"),
    candidate("a", 0, "2026-01-02T00:00:00Z", "middle"),
    candidate("a", 1, "2026-01-04T00:00:00Z", "ai"),
  ];
  const selected = selectFeedCommentPreviews(["a"], rows).get("a")!;
  assert.deepEqual(selected.map((row) => row.id), ["middle", "new"]);
  assert.equal(selected.some((row) => row.origin === "ai_autonomous"), false);
});

test("AI previews are hidden by default: an AI-only thread yields nothing", () => {
  const rows = [
    candidate("a", 1, "2026-01-01T00:00:00Z", "ai-old"),
    candidate("a", 1, "2026-01-03T00:00:00Z", "ai-new"),
  ];
  assert.deepEqual(selectFeedCommentPreviews(["a"], rows).get("a"), []);
});

test("AI fallback selects only the newest one when the flag is on and no visible human exists", () => {
  const rows = [
    candidate("a", 1, "2026-01-01T00:00:00Z", "ai-old"),
    candidate("a", 1, "2026-01-03T00:00:00Z", "ai-new"),
  ];
  const selected = selectFeedCommentPreviews(["a"], rows, { aiPreview: true }).get("a")!;
  assert.deepEqual(selected.map((row) => row.id), ["ai-new"]);
});

test("the flag only reclaims empty threads: a mixed thread stays human-only either way", () => {
  const rows = [
    candidate("a", 0, "2026-01-01T00:00:00Z", "human"),
    candidate("a", 1, "2026-01-03T00:00:00Z", "ai"),
  ];
  for (const options of [{}, { aiPreview: true }]) {
    const selected = selectFeedCommentPreviews(["a"], rows, options).get("a")!;
    assert.deepEqual(selected.map((row) => row.id), ["human"]);
  }
});

test("the SQL builders drop the AI branch and narrow counts to humans when the flag is off", () => {
  const off = feedCommentCandidatesSql(["a"], null).sql;
  const on = feedCommentCandidatesSql(["a"], null, { aiPreview: true }).sql;
  // AI 分支是 UNION ALL 的第二段：关闭时整段不生成，而不是读完再丢掉。
  assert.equal(off.includes("UNION ALL"), false, "AI branch must not reach the query plan");
  assert.equal(on.includes("UNION ALL"), true);
  assert.equal(on.includes("1 AS kind"), true);

  // 计数口径必须跟着预览走，否则卡片会出现「N 条回复」却没有可预览内容（R28）。
  // visibility.sql 里本来就有一个 isSynthetic 判断（放行 AI 作者），所以看的是
  // 是否在 WHERE 末尾额外挂了「只算真人」那一段。
  const humanOnlyCount = /AND u\."isSynthetic" = FALSE\s+GROUP BY/;
  assert.match(feedVisibleCountsSql(["a"], null).sql, humanOnlyCount);
  assert.doesNotMatch(feedVisibleCountsSql(["a"], null, { aiPreview: true }).sql, humanOnlyCount);
});

test("setting flags parse fail-closed", () => {
  for (const value of [null, undefined, "", "0", "false", "no", "  "]) {
    assert.equal(parseSettingFlag(value), false, `${String(value)} must read as off`);
  }
  for (const value of ["1", "true", " TRUE ", "True"]) {
    assert.equal(parseSettingFlag(value), true, `${value} must read as on`);
  }
});

test("stable ID tie-break is deterministic in both selection and display", () => {
  const rows = [
    candidate("a", 0, "2026-01-01T00:00:00Z", "b"),
    candidate("a", 0, "2026-01-01T00:00:00Z", "a"),
  ];
  assert.deepEqual(selectFeedCommentPreviews(["a"], rows).get("a")!.map((row) => row.id), ["a", "b"]);
});

test("candidate/final memory bounds hold for SSR, lazy and absolute shared-feed pages", () => {
  for (const n of [24, 30, 300]) {
    const ids = Array.from({ length: n }, (_, i) => `article-${i}`);
    const candidates = ids.flatMap((id) => [
      candidate(id, 0, "2026-01-01T00:00:00Z"),
      candidate(id, 0, "2026-01-02T00:00:00Z"),
      candidate(id, 1, "2026-01-03T00:00:00Z"),
    ]);
    assert.equal(candidates.length, 3 * n);
    const selected = selectFeedCommentPreviews(ids, candidates);
    assert.equal([...selected.values()].flat().length, 2 * n);
    assert.ok([...selected.values()].every((rows) => rows.every((row) => row.content.length <= 1024)));
  }
});

test("preview failure preserves count and vice versa", async (t) => {
  t.mock.method(console, "error", () => {});
  const counts = new Map([["a", 7]]);
  const previews = new Map([["a", []]]);
  const previewFailed = await loadFeedCommentBatch(["a"], null, "load-id", {
    previews: async () => { throw Object.assign(new Error("statement timeout"), { code: "57014" }); },
    counts: async () => counts,
  });
  assert.equal(previewFailed.previews, null);
  assert.equal(previewFailed.counts, counts);

  const countFailed = await loadFeedCommentBatch(["a"], null, "load-id", {
    previews: async () => previews,
    counts: async () => { throw new Error("database unavailable"); },
  });
  assert.equal(countFailed.previews, previews);
  assert.equal(countFailed.counts, null);
});

test("empty page performs neither comment data read", async () => {
  let reads = 0;
  const result = await loadFeedCommentBatch([], null, "load-id", {
    previews: async () => { reads += 1; return new Map(); },
    counts: async () => { reads += 1; return new Map(); },
  });
  assert.equal(reads, 0);
  assert.deepEqual(result.previews, new Map());
  assert.deepEqual(result.counts, new Map());
});

test("read error diagnostics are allowlisted categories", () => {
  assert.equal(feedCommentErrorCategory(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })), "statement_timeout");
  assert.equal(feedCommentErrorCategory(new Error("connection refused secret-host")), "database_unavailable");
  assert.equal(feedCommentErrorCategory(new Error("raw SQL with secret values")), "database_error");
});

test("loadFeedCommentBatch forwards aiPreview into both default readers", async (t) => {
  const statements: string[] = [];
  // prisma 是 Proxy：自有描述符里 $transaction 的 value 是 undefined（真的方法由 get 陷阱
  // 提供），所以 t.mock.method 会以为它不是方法而直接抛错。这里直接换属性再还原。
  stubPrismaMethod(t, "$transaction", async (run: (tx: unknown) => Promise<unknown>) => run({
    $queryRaw: async (query: unknown) => {
      // 第一个调用是 set_config 的 tagged template，第一个参数是字符串数组，忽略它。
      if (query && typeof query === "object" && !Array.isArray(query) && "sql" in query) {
        statements.push(String((query as { sql: unknown }).sql));
      }
      return [];
    },
  }));

  await loadFeedCommentBatch(["a"], null, "load-id", undefined, { aiPreview: true });

  assert.equal(statements.length, 2, "one preview read and one count read");
  assert.equal(statements.some((sql) => sql.includes("UNION ALL")), true, "preview reader received aiPreview");
  assert.equal(
    statements.some((sql) => /AND u\."isSynthetic" = FALSE\s+GROUP BY/.test(sql)),
    false,
    "count reader received aiPreview",
  );
});

// `prisma.siteSetting` 是可写的普通数据属性（不是方法），所以直接换掉委托对象，
// 并在用例结束时还原；别用 t.mock.getter —— 它只接受方法。
function stubSiteSetting(
  t: TestContext,
  findUnique: () => Promise<{ value: string } | null>,
): void {
  const client = prisma as unknown as Record<string, unknown>;
  const original = client.siteSetting;
  client.siteSetting = { findUnique };
  t.after(() => { client.siteSetting = original; });
}

// 同上：prisma 是 Proxy，$transaction 这类引擎方法的自有描述符 value 是 undefined，
// t.mock.method 会拒绝。直接赋值（会盖住 get 陷阱），结束时写回原函数。
function stubPrismaMethod(
  t: TestContext,
  name: string,
  implementation: (...args: never[]) => unknown,
): void {
  const client = prisma as unknown as Record<string, unknown>;
  const original = client[name];
  client[name] = implementation;
  t.after(() => { client[name] = original; });
}

test("site flag: 30s cache, invalidation refreshes, failures fail closed and are not cached", async (t) => {
  invalidateSiteSettingCache();
  let calls = 0;
  let stored: string | null = "1";
  let boom = false;
  stubSiteSetting(t, async () => {
    calls += 1;
    if (boom) throw new Error("relation site_settings does not exist");
    return stored === null ? null : { value: stored };
  });
  t.mock.method(console, "error", () => {});

  assert.equal(await isFeedAiRepliesEnabled(), true);
  assert.equal(await isFeedAiRepliesEnabled(), true);
  assert.equal(calls, 1, "the second read is served from the cache");

  stored = "0";
  assert.equal(await isFeedAiRepliesEnabled(), true, "still inside the 30s window");
  invalidateSiteSettingCache(SITE_SETTING_KEYS.feedAiReplies);
  assert.equal(await isFeedAiRepliesEnabled(), false);
  assert.equal(calls, 2, "one initial read plus the post-invalidation refresh");

  boom = true;
  invalidateSiteSettingCache();
  assert.equal(await isFeedAiRepliesEnabled(), false, "read failure is fail-closed");
  assert.equal(await isFeedAiRepliesEnabled(), false);
  assert.equal(calls, 4, "failures are not cached");
});

test("an in-flight read cannot resurrect a value invalidated while it was pending", async (t) => {
  invalidateSiteSettingCache();
  let calls = 0;
  let release: (row: { value: string }) => void = () => {};
  const inFlightRead = new Promise<{ value: string }>((resolve) => { release = resolve; });
  stubSiteSetting(t, async () => {
    calls += 1;
    return calls === 1 ? inFlightRead : { value: "0" };
  });

  const pending = isFeedAiRepliesEnabled();
  invalidateSiteSettingCache(SITE_SETTING_KEYS.feedAiReplies);
  release({ value: "1" });

  assert.equal(await pending, true, "the in-flight request still answers with the value it read");
  assert.equal(await isFeedAiRepliesEnabled(), false, "but the stale value was never cached");
  assert.equal(calls, 2);
});
