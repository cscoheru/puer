import { test } from "node:test";
import assert from "node:assert/strict";
import {
  feedCommentErrorCategory,
  loadFeedCommentBatch,
  selectFeedCommentPreviews,
  type CandidateRow,
} from "./feed-comment-preview.ts";

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

test("AI fallback selects only the newest one when no visible human exists", () => {
  const rows = [
    candidate("a", 1, "2026-01-01T00:00:00Z", "ai-old"),
    candidate("a", 1, "2026-01-03T00:00:00Z", "ai-new"),
  ];
  const selected = selectFeedCommentPreviews(["a"], rows).get("a")!;
  assert.deepEqual(selected.map((row) => row.id), ["ai-new"]);
  assert.equal(selectFeedCommentPreviews(["empty"], []).get("empty")!.length, 0);
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
