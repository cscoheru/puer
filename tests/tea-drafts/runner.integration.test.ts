/**
 * DB integration tests for runTeaDraftRunner — the transaction-orchestration
 * half of runner.ts (the pure `selectDrafts` half is covered by runner.test.ts).
 *
 * These exercise the reachable DB paths: create-once + deterministic id, the
 * unreviewed-draft gate (the dominant idempotency mechanism), the natural-day
 * cap, dry-run, below-threshold rejection, no-candidates, advisory-lock
 * serialization, and the existing-draft facts check.
 *
 * P2002 note: the duck-typed `isUniqueViolation` catch in the runner is a
 * last-line defense for the fetch→create race. Under the advisory lock +
 * unreviewed gate it is unreachable in normal operation, so it is NOT tested
 * by a contrived race here — its classification logic is unit-tested directly
 * in runner.test.ts. The existing-draft facts check (test below) covers the
 * realistic "draft already exists for this note" path.
 *
 * Isolation: refuses to run unless TEST_DATABASE_URL is set AND contains
 * "_test" (hard refuse on anything that looks like production). Skips cleanly
 * when the var is absent, so `test:unit` (which never loads this file) and a
 * dev machine without a _test DB are both unaffected.
 *
 * Run: TEST_DATABASE_URL='postgresql://..._test' npm run test:db
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { runTeaDraftRunner, type RunnerConfig } from "@/lib/tea-drafts/runner.ts";

const URL = process.env.TEST_DATABASE_URL;
if (URL && !URL.includes("_test")) {
  // Hard refuse: never run integration writes against a non-test database.
  throw new Error(
    `Refusing: TEST_DATABASE_URL must target a *_test database (got: ${URL}).`,
  );
}
const ENABLED = !!URL;

function makeClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return new PrismaClient({ adapter });
}

const prisma: PrismaClient | null = ENABLED ? makeClient(URL!) : null;

function db(): PrismaClient {
  if (!prisma) throw new Error("prisma not initialized (ENABLED=false)");
  return prisma;
}

// Deterministic IDs. NOTE_ID must satisfy tastingDraftId's cuid-ish check
// (≥16 lowercase alphanumeric) so the runner accepts it.
const USER_ID = "testrunneruser0001";
const NOTE_ID = "testrunnernote0001"; // 20 chars, matches /^[a-z0-9]{16,}$/
const TEA_ID = "testrunnertea00001";
const BOARD_ID = "testrunnerboard01";

// ~320 codepoints → contentLengthScore 3, comfortably over SCORE_THRESHOLD (2).
const LONG_CONTENT =
  "<p>" +
  "外观汤色金黄透亮，香气馥郁高扬，滋味醇厚饱满，回甘持久生津，叶底柔软均匀。".repeat(8) +
  "</p>";
// ~100 codepoints → passes the ≥80 hard gate but scores only 1 (below threshold 2).
const MEDIUM_CONTENT =
  "<p>" + "外观汤色香气滋味回甘耐泡，叶底均匀，入口顺滑。".repeat(4) + "</p>";

function config(over: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    authorId: USER_ID,
    noteIds: new Set([NOTE_ID]),
    boardId: BOARD_ID,
    limit: 1,
    dailyCap: 1,
    maxUnreviewed: 10,
    candidateFetchLimit: 10,
    ...over,
  };
}

async function seedNote(
  P: PrismaClient,
  over: { content?: string; source?: string; teaId?: string; title?: string } = {},
): Promise<void> {
  await P.tastingNote.upsert({
    where: { id: NOTE_ID },
    create: {
      id: NOTE_ID,
      title: over.title ?? "测试品鉴笔记",
      content: over.content ?? LONG_CONTENT,
      source: over.source ?? "manual",
      teaId: over.teaId ?? TEA_ID,
      authorId: USER_ID,
    },
    update: {
      title: over.title ?? "测试品鉴笔记",
      content: over.content ?? LONG_CONTENT,
      source: over.source ?? "manual",
      teaId: over.teaId ?? TEA_ID,
    },
  });
}

// Shared fixtures (user / tea / board) exist once for the whole suite.
before(async () => {
  if (!ENABLED) return;
  const P = db();
  await P.user.upsert({
    where: { id: USER_ID },
    create: { id: USER_ID, username: "testrunner", email: "testrunner@puer.local" },
    update: {},
  });
  await P.tea.upsert({
    where: { id: TEA_ID },
    create: {
      id: TEA_ID,
      name: "测试茶",
      brand: "测试品牌",
      year: 2024,
      type: "raw",
      createdBy: USER_ID,
    },
    update: {},
  });
  await P.board.upsert({
    where: { id: BOARD_ID },
    create: { id: BOARD_ID, name: "测试版块", slug: "testrunner" },
    update: {},
  });
});

// Each test starts with no draft and no note for NOTE_ID.
beforeEach(async () => {
  if (!ENABLED) return;
  const P = db();
  await P.article.deleteMany({
    where: { id: { startsWith: "tasting-draft_" }, authorId: USER_ID },
  });
  await P.tastingNote.deleteMany({ where: { authorId: USER_ID } });
});

after(async () => {
  if (!ENABLED) return;
  const P = db();
  // FK-safe order: articles → notes → tea → board → user.
  await P.article.deleteMany({
    where: { id: { startsWith: "tasting-draft_" }, authorId: USER_ID },
  });
  await P.tastingNote.deleteMany({ where: { authorId: USER_ID } });
  await P.tea.deleteMany({ where: { createdBy: USER_ID } });
  await P.board.deleteMany({ where: { id: BOARD_ID } });
  await P.user.deleteMany({ where: { id: USER_ID } });
  await P.$disconnect();
});

const SKIP = ENABLED ? false : "set TEST_DATABASE_URL to a *_test database";

test("create-once: an eligible note becomes exactly one draft with the deterministic id", { skip: SKIP }, async () => {
  const P = db();
  await seedNote(P);
  const res = await runTeaDraftRunner({ prisma: P, config: config() });
  assert.equal(res.status, "ok");
  assert.equal(res.created.length, 1);
  assert.equal(res.created[0], "tasting-draft_" + NOTE_ID);

  const art = await P.article.findUnique({ where: { id: "tasting-draft_" + NOTE_ID } });
  assert.ok(art, "draft was written");
  assert.equal(art!.type, "tasting");
  assert.equal(art!.status, "draft");
  assert.equal(art!.authorId, USER_ID);
  assert.equal(art!.boardId, BOARD_ID);
  assert.equal(art!.teaId, TEA_ID);
  // Trust contract: no tastingScores written by the runner.
  assert.equal(art!.tastingScores, null);
});

test("unreviewed gate: a second run while a draft exists is skipped, never a second draft", { skip: SKIP }, async () => {
  const P = db();
  await seedNote(P);
  const first = await runTeaDraftRunner({ prisma: P, config: config() });
  assert.equal(first.status, "ok");

  const second = await runTeaDraftRunner({ prisma: P, config: config() });
  assert.equal(second.status, "skipped-unreviewed-exists");
  assert.equal(second.created.length, 0);

  const count = await P.article.count({
    where: { id: { startsWith: "tasting-draft_" }, authorId: USER_ID },
  });
  assert.equal(count, 1);
});

test("daily cap: once today's draft is published, a further run is skipped-daily-cap", { skip: SKIP }, async () => {
  const P = db();
  await seedNote(P);
  await runTeaDraftRunner({ prisma: P, config: config() });
  // Simulate the admin publishing the draft — unreviewed gate then passes, but
  // the natural-day cap (the published draft counts as created today) blocks.
  await P.article.update({
    where: { id: "tasting-draft_" + NOTE_ID },
    data: { status: "published" },
  });
  const res = await runTeaDraftRunner({ prisma: P, config: config() });
  assert.equal(res.status, "skipped-daily-cap");
  assert.equal(res.created.length, 0);
});

test("dry-run selects but writes nothing", { skip: SKIP }, async () => {
  const P = db();
  await seedNote(P);
  const res = await runTeaDraftRunner({ prisma: P, config: config(), dryRun: true });
  assert.equal(res.status, "ok");
  assert.equal(res.selected.length, 1);
  assert.equal(res.created.length, 0);
  const art = await P.article.findUnique({ where: { id: "tasting-draft_" + NOTE_ID } });
  assert.equal(art, null);
});

test("below-threshold: a note that passes gates but scores <2 is rejected, not written", { skip: SKIP }, async () => {
  const P = db();
  await seedNote(P, { content: MEDIUM_CONTENT });
  const res = await runTeaDraftRunner({ prisma: P, config: config() });
  assert.equal(res.status, "ok");
  assert.equal(res.created.length, 0);
  assert.equal(res.rejected[0]?.reason, "below_score_threshold");
  const art = await P.article.findUnique({ where: { id: "tasting-draft_" + NOTE_ID } });
  assert.equal(art, null);
});

test("no-candidates: an allowlist pointing at no real note returns no-candidates", { skip: SKIP }, async () => {
  const P = db();
  await seedNote(P);
  const res = await runTeaDraftRunner({
    prisma: P,
    config: config({ noteIds: new Set(["nonexistentnote001"]) }),
  });
  assert.equal(res.status, "no-candidates");
  assert.equal(res.created.length, 0);
});

test("advisory lock: a run held out by another transaction's lock bows out immediately", { skip: SKIP }, async () => {
  const P = db();
  // A SEPARATE client (own pool/connection) holds the transaction-scoped lock
  // for the duration of its callback. The runner (on the main client) cannot
  // acquire it and must return skipped-already-running — proving serialization.
  const holder = makeClient(URL!);
  try {
    await holder.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended('tea-draft-runner', 0)) AS locked`;
      assert.equal(rows[0]?.locked, true);

      const res = await runTeaDraftRunner({ prisma: P, config: config({ dailyCap: 5 }), dryRun: true });
      assert.equal(res.status, "skipped-already-running");
      assert.equal(res.created.length, 0);
    });
  } finally {
    await holder.$disconnect();
  }
});

test("existing-draft facts: a note whose draft already exists (published) is not recreated", { skip: SKIP }, async () => {
  const P = db();
  await seedNote(P);
  // Pre-create a PUBLISHED draft for the same note (so the unreviewed gate
  // does NOT catch it) and raise the daily cap so the cap does NOT catch it.
  // The runner's existingDraftExists facts check must reject the note instead.
  await P.article.create({
    data: {
      id: "tasting-draft_" + NOTE_ID,
      type: "tasting",
      title: "已发布的旧草稿",
      content: "<p>占位正文。</p>",
      authorId: USER_ID,
      boardId: BOARD_ID,
      status: "published",
      tags: ["品鉴"],
    },
  });
  const res = await runTeaDraftRunner({ prisma: P, config: config({ dailyCap: 5 }) });
  assert.equal(res.status, "ok");
  assert.equal(res.created.length, 0);
  assert.equal(
    res.rejected.find((r) => r.id === NOTE_ID)?.reason,
    "draft_already_exists",
  );
  const dupes = await P.article.count({ where: { id: "tasting-draft_" + NOTE_ID } });
  assert.equal(dupes, 1);
});
