/**
 * Pure unit tests for the selection composition in runner.ts.
 *
 * These cover the logic that decides which notes become drafts — gates → score
 * → threshold → rank → cap → assemble — WITHOUT a database. The DB orchestration
 * (advisory lock, idempotency, caps) is covered by runner.integration.test.ts.
 *
 * Run: node --test --test-reporter=spec src/lib/tea-drafts/runner.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectDrafts,
  startOfShanghaiDayUtc,
  isUniqueViolation,
  applyAdapt,
  attachVideos,
  type RunnerConfig,
  type CandidateFacts,
  type AdaptClient,
  type VideoClient,
  type CreatedRow,
} from "./runner.ts";
import type { NormalizedNote } from "./normalize.ts";
import type { AdaptSource, AdaptResult } from "./adapt.ts";

const AUTHOR = "auth-1";
const BOARD = "board-1";
const ID_A = "cjld2cjxh0000qzrmn831i7rn";
const ID_B = "cjld2cjxh0001qzrmn831i7rn0";
const ID_C = "cjld2cjxh0002qzrmn831i7rn1";

// ~300 codepoints of safe text → contentLengthScore 3 (≥200), comfortably over
// SCORE_THRESHOLD (2) with no brew/media needed.
const LONG_CONTENT =
  "<p>" + "外观汤色香气滋味回甘耐泡，叶底均匀，入口顺滑，回甘持久，汤色金黄透亮。".repeat(10) + "</p>";
// ~100 codepoints → passes the ≥80 hard gate but scores only 1 (below threshold).
const MEDIUM_CONTENT =
  "<p>" + "外观汤色香气滋味回甘耐泡，叶底均匀，入口顺滑，回甘持久。".repeat(4) + "</p>";

function nn(over: Partial<NormalizedNote>): NormalizedNote {
  return {
    id: ID_A,
    title: "某山头古树春茶",
    content: LONG_CONTENT,
    summary: null,
    teaId: "tea-1",
    authorId: AUTHOR,
    source: "manual",
    brewMethod: null,
    waterTemp: null,
    teaWeight: null,
    steepCount: null,
    images: null,
    videoUrl: null,
    createdAt: 1000,
    ...over,
  };
}

function factsOk(): CandidateFacts {
  return { authorActive: true, existingDraftExists: false, teaAlreadyCovered: false };
}

function cfg(over: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    authorId: AUTHOR,
    noteIds: new Set([ID_A]),
    boardId: BOARD,
    limit: 1,
    dailyCap: 1,
    maxUnreviewed: 10,
    candidateFetchLimit: 200,
    ...over,
  };
}

function run(notes: NormalizedNote[], config: RunnerConfig, factsOverride?: Map<string, CandidateFacts>) {
  const facts = factsOverride ?? new Map(notes.map((n) => [n.id, factsOk()]));
  return selectDrafts({
    candidates: notes,
    factsByNote: facts,
    scoringCtx: { recentAutoDraftTeaId: null },
    config,
  });
}

test("a fully-eligible, score-≥2 note is selected and assembled verbatim", () => {
  const note = nn({});
  const res = run([note], cfg());
  assert.equal(res.selected.length, 1);
  assert.equal(res.selected[0].id, "tasting-draft_" + ID_A);
  assert.equal(res.selected[0].status, "draft");
  assert.equal(res.selected[0].boardId, BOARD);
  assert.equal(res.selected[0].authorId, AUTHOR);
  assert.deepEqual(res.rejected, []);
  // Body is the escaped verbatim paragraph (no invention).
  assert.ok(res.selected[0].content.startsWith("<p>"));
  assert.ok(!("tastingScores" in res.selected[0]));
});

test("source evernote → passes (accepted alongside manual)", () => {
  const res = run([nn({ source: "evernote" })], cfg());
  assert.equal(res.selected.length, 1);
  assert.deepEqual(res.rejected, []);
});

test("source unknown → rejected source_not_manual", () => {
  const res = run([nn({ source: "import" })], cfg());
  assert.equal(res.selected.length, 0);
  assert.deepEqual(res.rejected, [{ id: ID_A, reason: "source_not_manual" }]);
});

test("author mismatch → rejected author_not_configured", () => {
  const res = run([nn({ authorId: "someone-else" })], cfg());
  assert.equal(res.selected.length, 0);
  assert.equal(res.rejected[0].reason, "author_not_configured");
});

test("note not in allowlist → rejected note_not_in_allowlist", () => {
  const res = run([nn({ id: ID_B })], cfg({ noteIds: new Set([ID_A]) }));
  assert.equal(res.selected.length, 0);
  assert.equal(res.rejected[0].reason, "note_not_in_allowlist");
});

test("empty allowlist (wildcard) → note id not restricted", () => {
  const res = run([nn({ id: ID_B })], cfg({ noteIds: new Set() }));
  assert.equal(res.selected.length, 1);
});

test("inactive author → rejected author_inactive_or_banned", () => {
  const facts = new Map([[ID_A, { authorActive: false, existingDraftExists: false, teaAlreadyCovered: false }]]);
  const res = run([nn({})], cfg(), facts);
  assert.equal(res.selected.length, 0);
  assert.equal(res.rejected[0].reason, "author_inactive_or_banned");
});

test("existing draft → rejected draft_already_exists", () => {
  const facts = new Map([[ID_A, { authorActive: true, existingDraftExists: true, teaAlreadyCovered: false }]]);
  const res = run([nn({})], cfg(), facts);
  assert.equal(res.selected.length, 0);
  assert.equal(res.rejected[0].reason, "draft_already_exists");
});

test("tea already covered → rejected tea_already_covered", () => {
  const facts = new Map([[ID_A, { authorActive: true, existingDraftExists: false, teaAlreadyCovered: true }]]);
  const res = run([nn({})], cfg(), facts);
  assert.equal(res.selected.length, 0);
  assert.equal(res.rejected[0].reason, "tea_already_covered");
});

test("passes gates but score < threshold → rejected below_score_threshold", () => {
  const res = run([nn({ content: MEDIUM_CONTENT })], cfg());
  assert.equal(res.selected.length, 0);
  assert.equal(res.rejected[0].reason, "below_score_threshold");
});

test("disqualifying repost signal → rejected disqualifying_signal", () => {
  const res = run([nn({ content: "<p>转载自别处。" + "外观汤色香气滋味回甘耐泡叶底均匀。".repeat(10) + "</p>" })], cfg());
  assert.equal(res.selected.length, 0);
  assert.equal(res.rejected[0].reason, "disqualifying_signal");
});

test("missing facts → fail-closed (treated as inactive author)", () => {
  const res = run([nn({})], cfg(), new Map());
  assert.equal(res.selected.length, 0);
  assert.equal(res.rejected[0].reason, "author_inactive_or_banned");
});

test("limit cap: two eligible notes, limit 1 → newer selected, other rank_cap", () => {
  const older = nn({ id: ID_B, createdAt: 1000 });
  const newer = nn({ id: ID_C, createdAt: 2000 });
  const res = run([older, newer], cfg({ noteIds: new Set([ID_B, ID_C]), limit: 1 }));
  assert.equal(res.selected.length, 1);
  assert.equal(res.selected[0].id, "tasting-draft_" + ID_C); // newer wins (createdAt DESC)
  const reasons = res.rejected.map((r) => r.reason);
  assert.deepEqual(reasons, ["rank_cap"]);
  assert.equal(res.rejected[0].id, ID_B);
});

test("limit 2: both eligible → both selected, no rank_cap", () => {
  const a = nn({ id: ID_B, createdAt: 1000 });
  const b = nn({ id: ID_C, createdAt: 2000 });
  const res = run([a, b], cfg({ noteIds: new Set([ID_B, ID_C]), limit: 2 }));
  assert.equal(res.selected.length, 2);
  assert.deepEqual(res.rejected, []);
});

test("empty candidates → empty selected and rejected", () => {
  const res = run([], cfg());
  assert.deepEqual(res.selected, []);
  assert.deepEqual(res.rejected, []);
});

test("teaId diversity penalty drops a same-tea note below threshold", () => {
  // MEDIUM_CONTENT scores 1; with the penalty it becomes 0 → below threshold.
  const res = selectDrafts({
    candidates: [nn({ content: MEDIUM_CONTENT, teaId: "tea-1" })],
    factsByNote: new Map([[ID_A, factsOk()]]),
    scoringCtx: { recentAutoDraftTeaId: "tea-1" },
    config: cfg(),
  });
  assert.equal(res.selected.length, 0);
  assert.equal(res.rejected[0].reason, "below_score_threshold");
});

test("selected draft carries validated media and brew fields from the note", () => {
  const res = selectDrafts({
    candidates: [
      nn({
        brewMethod: "盖碗",
        waterTemp: 95,
        teaWeight: "5g",
        steepCount: 8,
        images: ["/uploads/forum/a.jpg", "https://cdn.example/b.jpg", "javascript:alert(1)"],
        videoUrl: "https://cdn.example/v.mp4",
      }),
    ],
    factsByNote: new Map([[ID_A, factsOk()]]),
    scoringCtx: { recentAutoDraftTeaId: null },
    config: cfg(),
  });
  const d = res.selected[0];
  assert.equal(d.brewMethod, "盖碗");
  assert.equal(d.waterTemp, 95);
  // Only the two allowed image URLs survive; javascript: is dropped.
  assert.deepEqual(d.images, ["/uploads/forum/a.jpg", "https://cdn.example/b.jpg"]);
  assert.equal(d.videoUrl, "https://cdn.example/v.mp4");
});

// ─── startOfShanghaiDayUtc ───────────────────────────────────────────────

test("startOfShanghaiDayUtc: 16:00 UTC = 00:00 next-day Shanghai → same instant", () => {
  // 2026-08-01T16:00:00Z is exactly 2026-08-02 00:00 Asia/Shanghai.
  const dayStart = startOfShanghaiDayUtc(new Date("2026-08-01T16:00:00Z"));
  assert.equal(dayStart.getTime(), Date.parse("2026-08-01T16:00:00Z"));
});

test("startOfShanghaiDayUtc: 15:59 UTC = prev-minute of Shanghai midnight → previous day", () => {
  const dayStart = startOfShanghaiDayUtc(new Date("2026-08-01T15:59:59Z"));
  // Shanghai day is still 2026-08-01 → starts at 2026-07-31T16:00:00Z.
  assert.equal(dayStart.getTime(), Date.parse("2026-07-31T16:00:00Z"));
});

test("startOfShanghaiDayUtc: midnight UTC is 08:00 Shanghai → same Shanghai day", () => {
  const a = startOfShanghaiDayUtc(new Date("2026-08-01T00:00:00Z"));
  const b = startOfShanghaiDayUtc(new Date("2026-08-01T07:59:59Z"));
  assert.equal(a.getTime(), b.getTime());
  assert.equal(a.getTime(), Date.parse("2026-07-31T16:00:00Z"));
});

// ─── isUniqueViolation (P2002 classification, pure) ──────────────────────
// P2002 is unreachable in single-threaded operation (the advisory lock +
// unreviewed gate always intercept a duplicate first), so its classification
// logic is unit-tested here in isolation rather than via a contrived race.

test("isUniqueViolation: true for an object carrying code 'P2002'", () => {
  assert.equal(isUniqueViolation({ code: "P2002" }), true);
  assert.equal(isUniqueViolation({ code: "P2002", message: "x", meta: {} }), true);
});

test("isUniqueViolation: false for any other Prisma code, non-object, or missing code", () => {
  assert.equal(isUniqueViolation({ code: "P2025" }), false); // record not found
  assert.equal(isUniqueViolation({ message: "P2002" }), false); // code key absent
  assert.equal(isUniqueViolation(new Error("boom")), false); // no code property
  assert.equal(isUniqueViolation(null), false);
  assert.equal(isUniqueViolation(undefined), false);
  assert.equal(isUniqueViolation("P2002"), false);
});

// ─── applyAdapt (Phase D post-commit rewrite decisions, pure w/ fake writer) ─

const ADAPT_SRC: AdaptSource = {
  title: "某山头古树春茶",
  plainText: "汤色金黄,入口顺滑,回甘持久。" .repeat(6),
  brewFields: { method: "盖碗", temp: 100, weight: "7克", steep: 7 },
  corpus: "汤色金黄 100 7 盖碗",
};
const CREATED_AT = new Date("2026-08-02T00:00:00Z");
function makeRow(id: string): CreatedRow {
  return { id, createdAt: CREATED_AT, adaptSource: ADAPT_SRC, title: ADAPT_SRC.title };
}

/** Fake writer that records every updateMany call and returns a fixed count. */
function fakeWriter(count: number) {
  const calls: Array<{
    where: { id: string; updatedAt: Date; status: string };
    data: { content: string; summary: string };
  }> = [];
  const writer: AdaptClient = {
    article: {
      updateMany: async (args) => {
        calls.push(args);
        return { count };
      },
    },
  };
  return { writer, calls };
}

const OK_ADAPT: AdaptResult = { ok: true, content: "<p>改编正文</p>", summary: "改编摘要" };

test("applyAdapt: ok result → one conditional updateMany with updatedAt guard, updated=true", async () => {
  const { writer, calls } = fakeWriter(1);
  const out = await applyAdapt({
    writer,
    createdRows: [makeRow("tasting-draft_abc")],
    adaptDraft: async () => OK_ADAPT,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].where.id, "tasting-draft_abc");
  assert.equal(calls[0].where.status, "draft");
  assert.deepEqual(calls[0].where.updatedAt, CREATED_AT); // human-edit guard
  assert.equal(calls[0].data.content, "<p>改编正文</p>");
  assert.equal(calls[0].data.summary, "改编摘要");
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "tasting-draft_abc");
  assert.equal(out[0].ok, true);
  assert.equal(out[0].updated, true);
  assert.equal(out[0].reason, undefined);
});

test("applyAdapt: human edited first (count=0) → updateMany called, updated=false, reason set", async () => {
  const { writer, calls } = fakeWriter(0);
  const out = await applyAdapt({
    writer,
    createdRows: [makeRow("tasting-draft_abc")],
    adaptDraft: async () => OK_ADAPT,
  });
  assert.equal(calls.length, 1); // attempted, but matched 0 rows
  assert.equal(out[0].ok, true);
  assert.equal(out[0].updated, false);
  assert.match(out[0].reason ?? "", /human-edited/);
});

test("applyAdapt: adaptDraft returns ok:false → updateMany NOT called (verbatim kept)", async () => {
  const { writer, calls } = fakeWriter(1);
  const out = await applyAdapt({
    writer,
    createdRows: [makeRow("tasting-draft_abc")],
    adaptDraft: async () => ({ ok: false, reason: "ungrounded number: 2024" }),
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(out, [
    { id: "tasting-draft_abc", ok: false, updated: false, reason: "ungrounded number: 2024" },
  ]);
});

test("applyAdapt: adaptDraft throws → caught, updateMany NOT called, ok:false", async () => {
  const { writer, calls } = fakeWriter(1);
  const out = await applyAdapt({
    writer,
    createdRows: [makeRow("tasting-draft_abc")],
    adaptDraft: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(calls.length, 0);
  assert.equal(out[0].ok, false);
  assert.equal(out[0].updated, false);
  assert.match(out[0].reason ?? "", /adapt threw: network down/);
});

test("applyAdapt: multiple rows → one outcome per row, order preserved", async () => {
  const { writer, calls } = fakeWriter(1);
  const out = await applyAdapt({
    writer,
    createdRows: [makeRow("tasting-draft_a"), makeRow("tasting-draft_b"), makeRow("tasting-draft_c")],
    adaptDraft: async () => OK_ADAPT,
  });
  assert.deepEqual(
    out.map((o) => o.id),
    ["tasting-draft_a", "tasting-draft_b", "tasting-draft_c"],
  );
  assert.equal(calls.length, 3);
  assert.equal(out.every((o) => o.ok && o.updated), true);
});

// ─── attachVideos (post-commit slideshow-video attachment; fake writer + injected generator) ──

/** Fake VideoClient that records every updateMany call and returns a fixed count. */
function fakeVideoWriter(count: number) {
  const calls: Array<{ where: { id: string; status: string }; data: { videoUrl: string } }> = [];
  const writer: VideoClient = {
    article: {
      updateMany: async (args) => {
        calls.push(args);
        return { count };
      },
    },
  };
  return { writer, calls };
}

function rowWithImages(id: string, n: number): CreatedRow {
  const row = makeRow(id);
  row.images = Array.from({ length: n }, (_, i) => `/uploads/evernote/img${i}.jpg`);
  return row;
}

test("attachVideos: ≥4 images + gen ok → updateMany sets videoUrl, attached=true", async () => {
  const { writer, calls } = fakeVideoWriter(1);
  const out = await attachVideos({
    writer,
    createdRows: [rowWithImages("tasting-draft_v1", 6)],
    generateVideo: async () => ({ videoUrl: "/uploads/videos/abc.mp4" }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].where.id, "tasting-draft_v1");
  assert.equal(calls[0].where.status, "draft");
  assert.equal(calls[0].data.videoUrl, "/uploads/videos/abc.mp4");
  assert.equal(out[0].attached, true);
  assert.equal(out[0].reason, undefined);
});

test("attachVideos: <4 images → no generation, no updateMany, reason set", async () => {
  const { writer, calls } = fakeVideoWriter(1);
  let genCalled = false;
  const out = await attachVideos({
    writer,
    createdRows: [rowWithImages("tasting-draft_v2", 3)],
    generateVideo: async () => { genCalled = true; return null; },
  });
  assert.equal(genCalled, false, "generator not called for <4 images");
  assert.equal(calls.length, 0);
  assert.equal(out[0].attached, false);
  assert.match(out[0].reason ?? "", /too few images/);
});

test("attachVideos: generator returns null → no updateMany, draft kept without video", async () => {
  const { writer, calls } = fakeVideoWriter(1);
  const out = await attachVideos({
    writer,
    createdRows: [rowWithImages("tasting-draft_v3", 5)],
    generateVideo: async () => null,
  });
  assert.equal(calls.length, 0);
  assert.equal(out[0].attached, false);
  assert.match(out[0].reason ?? "", /video generation failed/);
});

test("attachVideos: human published first (count=0) → updateMany called, attached=false", async () => {
  const { writer, calls } = fakeVideoWriter(0);
  const out = await attachVideos({
    writer,
    createdRows: [rowWithImages("tasting-draft_v4", 4)],
    generateVideo: async () => ({ videoUrl: "/uploads/videos/late.mp4" }),
  });
  assert.equal(calls.length, 1);
  assert.equal(out[0].attached, false);
  assert.match(out[0].reason ?? "", /human-published/);
});

test("attachVideos: empty createdRows (dry-run) → no calls, empty outcome", async () => {
  const { writer, calls } = fakeVideoWriter(1);
  const out = await attachVideos({
    writer,
    createdRows: [],
    generateVideo: async () => ({ videoUrl: "/uploads/videos/x.mp4" }),
  });
  assert.equal(calls.length, 0);
  assert.equal(out.length, 0);
});
