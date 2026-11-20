import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { prisma } from "./prisma.ts";
import { commentVisibility } from "./comment-visibility.ts";
import {
  createFeedCommentWithVisibleParent,
  ParentCommentConflict,
  type FeedCommentInput,
} from "./comment-feed-write.ts";
import {
  loadFeedCommentBatch,
  readFeedCommentCandidates,
  readPreviewCandidates,
  readVisibleCounts,
} from "./feed-comment-preview.ts";
import { FEED_COMMENT_LIMITS } from "./feed-comment-contract.ts";
import { LIMIT_POST } from "./rate-limit.ts";
import type { Actor } from "./permissions.ts";

/**
 * Opt-in real PostgreSQL tests. Never fall back to DATABASE_URL here: an
 * accidental production URL must be a configuration error, not a test target.
 * Run with both variables pointing at the same disposable loopback database:
 *
 *   FEED_INLINE_TEST_DATABASE_URL=postgresql://user@127.0.0.1:PORT/db \
 *   DATABASE_URL=postgresql://user@127.0.0.1:PORT/db \
 *   npm run test:feed:integration
 *
 * `npm run test:unit` also collects this file (it lives in src/lib). Two tests
 * need `t.mock.module`, which plain `node --test` does not provide; they skip
 * with a pointer to the command above instead of failing the unit run.
 */
const TEST_URL = process.env.FEED_INLINE_TEST_DATABASE_URL;

/**
 * Importing prisma.ts binds the app client to DATABASE_URL, while the pg client
 * below uses FEED_INLINE_TEST_DATABASE_URL. If they differ, fixtures are written
 * to one database and assertions read another (or, worse, to a real one).
 */
export function assertIntegrationTarget(
  testUrl: string | undefined,
  databaseUrl: string | undefined,
): string | null {
  if (!testUrl) return null;
  // `new URL("postgresql://u@[::1]:5432/db").hostname` is the bracketed "[::1]",
  // so an IPv6 loopback URL would otherwise be refused by the allowlist below.
  const loopbackHost = (hostname: string) => hostname.replace(/^\[|\]$/g, "");
  const url = new URL(testUrl);
  assert.ok(["postgresql:", "postgres:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(loopbackHost(url.hostname)),
    "FEED_INLINE_TEST_DATABASE_URL must be loopback-only");
  assert.ok(databaseUrl, "DATABASE_URL must point at the same disposable database");
  const ambient = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(loopbackHost(ambient.hostname)),
    "DATABASE_URL must be loopback-only while integration fixtures run");
  assert.equal(ambient.hostname, url.hostname, "DATABASE_URL host must match the test URL");
  assert.equal(ambient.port, url.port, "DATABASE_URL port must match the test URL");
  assert.equal(ambient.pathname, url.pathname, "DATABASE_URL database must match the test URL");
  return testUrl;
}

test("integration target guard refuses a mismatched or non-loopback database", () => {
  const disposable = "postgresql://puer_test@127.0.0.1:55439/puer_feed_utf8";
  assert.equal(assertIntegrationTarget(undefined, undefined), null);
  assert.throws(() => assertIntegrationTarget(disposable, undefined));
  assert.throws(() => assertIntegrationTarget(disposable, "postgresql://u@db.example.com:5432/puer"));
  assert.throws(() => assertIntegrationTarget(disposable, "postgresql://puer_test@127.0.0.1:5432/puer_feed_utf8"));
  assert.equal(assertIntegrationTarget(disposable, disposable), disposable);
});

const ENABLED = Boolean(assertIntegrationTarget(TEST_URL, process.env.DATABASE_URL));

/**
 * Without the env the whole suite skips and node still exits 0 — a green run
 * that proved nothing. The npm script sets this so the only way to get a
 * passing `test:feed:integration` is to actually have run it.
 */
if (process.env.FEED_INLINE_REQUIRE_DB === "1" && !ENABLED) {
  throw new Error(
    "FEED_INLINE_TEST_DATABASE_URL and DATABASE_URL must point at the same loopback database; " +
    "an empty run is not a pass",
  );
}

/**
 * `t.mock.module` only exists under --experimental-test-module-mocks. The
 * module-mocking tests call this first so a runner without the flag reports a
 * readable skip naming the right command, not `TypeError: t.mock.module is not
 * a function`.
 */
const MODULE_MOCKS_HINT =
  "module mocks unavailable; run `npm run test:feed:integration` (adds --experimental-test-module-mocks)";

function skipWithoutModuleMocks(t: TestContext): boolean {
  if (typeof (t.mock as { module?: unknown }).module === "function") return false;
  t.skip(MODULE_MOCKS_HINT);
  return true;
}

const PREFIX = "feed-inline-it-";
const NOW = new Date("2026-11-18T00:00:00.000Z");
const at = (hour: number) => new Date(Date.UTC(2026, 10, 18, hour));
const id = (name: string) => `${PREFIX}${name}`;

const realA: Actor = { id: id("user-a"), role: "user", isSynthetic: false };
const realB: Actor = { id: id("user-b"), role: "user", isSynthetic: false };
const realC: Actor = { id: id("user-c"), role: "user", isSynthetic: false };
const moderator: Actor = { id: id("moderator"), role: "moderator", isSynthetic: false };
const syntheticAdmin: Actor = { id: id("synthetic-admin"), role: "admin", isSynthetic: true };
const realAdmin: Actor = { id: id("real-admin"), role: "admin", isSynthetic: false };
const bot: Actor = { id: id("bot"), role: "system", isSynthetic: true };
const actors = [realA, realB, realC, moderator, syntheticAdmin, realAdmin, bot];
const bulkIds = Array.from({ length: 300 }, (_, n) => id(`bulk-${n}`));
let sessionUser: Actor | null = null;

async function resetFixtures() {
  await prisma.article.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.user.createMany({
    data: actors.map((actor, n) => ({
      id: actor.id,
      uid: 900000 + n,
      username: actor.id,
      email: `${actor.id}@example.invalid`,
      preferenceTags: [],
      role: actor.role ?? "user",
      isSynthetic: actor.isSynthetic ?? false,
      level: 1,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  });
  const articleIds = [id("main"), id("ai"), id("long"), id("write"), ...bulkIds];
  await prisma.article.createMany({
    data: articleIds.map((articleId) => ({
      id: articleId,
      type: "discussion",
      title: "Synthetic integration fixture",
      content: "Synthetic integration fixture",
      tags: [],
      images: [],
      status: "published",
      visibility: "public",
      origin: "human",
      authorId: realA.id,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  });

  const mainComments = [
    ["human-old", realA.id, "human", "published", null, 1, "old human"],
    ["human-mid", realA.id, "human", "published", null, 2, "middle human"],
    ["human-new", realB.id, null, "published", null, 3, "new human"],
    ["ai-old", bot.id, "ai_autonomous", "published", null, 4, "old AI"],
    ["ai-new", bot.id, "ai_from_notes", "published", null, 8, "new AI"],
    ["synthetic-unmarked", bot.id, null, "published", null, 9, "hidden synthetic"],
    ["pending-own", realA.id, "human", "pending_review", null, 5, "own pending"],
    ["pending-other", realB.id, "human", "pending_review", null, 6, "other pending"],
    ["rejected-other", realB.id, "human", "rejected", null, 7, "rejected"],
    ["orphan-visible", realC.id, "human", "published", id("synthetic-unmarked"), 10, "visible orphan"],
  ] as const;
  const aiComments = [
    ["ai-only-old", bot.id, "ai_autonomous", "published", null, 1, "old AI"],
    ["ai-only-new", bot.id, "ai_autonomous", "published", null, 2, "new AI"],
    ["ai-only-unmarked", bot.id, null, "published", null, 3, "hidden synthetic"],
    ["ai-pending-own", realA.id, "human", "pending_review", null, 4, "own pending"],
    ["ai-rejected", realB.id, "human", "rejected", null, 5, "rejected"],
  ] as const;
  const longText = `🍵${"茶".repeat(1023)}尾部`;
  const longComments = [
    ["long", realA.id, "human", "published", null, 1, longText],
    ["exact", realB.id, "human", "published", null, 2, "茶".repeat(1024)],
  ] as const;

  const commentRow = (
    articleId: string,
    row: readonly [string, string, string | null, string, string | null, number, string],
  ) => ({
    id: id(row[0]),
    articleId,
    authorId: row[1],
    origin: row[2],
    status: row[3],
    parentId: row[4],
    createdAt: at(row[5]),
    updatedAt: at(row[5]),
    content: row[6],
    images: [],
  });
  await prisma.comment.createMany({
    data: [
      ...mainComments.map((row) => commentRow(id("main"), row)),
      ...aiComments.map((row) => commentRow(id("ai"), row)),
      ...longComments.map((row) => commentRow(id("long"), row)),
      ...bulkIds.flatMap((articleId, n) => [0, 1, 2].map((kind) => ({
        id: id(`bulk-${n}-${kind}`),
        articleId,
        authorId: kind === 2 ? bot.id : realA.id,
        origin: kind === 2 ? "ai_autonomous" : "human",
        status: "published",
        parentId: null,
        content: `bulk ${n} ${kind}`,
        images: [],
        createdAt: at(kind),
        updatedAt: at(kind),
      }))),
    ],
  });
}

before(async () => {
  if (ENABLED) await resetFixtures();
});

after(async () => {
  if (!ENABLED) return;
  await resetFixtures();
  await prisma.$disconnect();
});

function previewIds(
  batch: Awaited<ReturnType<typeof loadFeedCommentBatch>>,
  articleId: string,
): string[] {
  return batch.previews!.get(articleId)!.map((row) => row.id);
}

test("real SQL and Prisma visibility return identical IDs for every actor", { skip: !ENABLED }, async () => {
  for (const actor of [null, realA, realB, realC, moderator, syntheticAdmin] as const) {
    const visibility = commentVisibility(actor);
    const expected = await prisma.comment.findMany({
      where: { articleId: id("main"), AND: [visibility.prismaWhere] },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const actual = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM comments c
      JOIN users u ON u.id = c."authorId"
      WHERE c."articleId" = ${id("main")} AND ${visibility.sql}
      ORDER BY c.id ASC
    `;
    assert.deepEqual(actual, expected, actor?.id ?? "anonymous");
  }
});

test("human-first previews and whole-tree counts match GET visibility", { skip: !ENABLED }, async () => {
  const cases: Array<[Actor | null, string[], number]> = [
    [null, [id("human-mid"), id("human-new")], 6],
    [realA, [id("human-new"), id("pending-own")], 7],
    [realB, [id("human-new"), id("pending-other")], 7],
    [realC, [id("human-mid"), id("human-new")], 6],
    [moderator, [id("pending-other"), id("rejected-other")], 9],
    [syntheticAdmin, [id("human-mid"), id("human-new")], 6],
  ];
  for (const [actor, expectedPreview, expectedCount] of cases) {
    // 这些数字是「AI 开关打开」口径（整棵树都计数）。默认关闭的口径见下一个用例。
    const batch = await loadFeedCommentBatch([id("main")], actor, id("load"), undefined, { aiPreview: true });
    assert.deepEqual(previewIds(batch, id("main")), expectedPreview, actor?.id ?? "anonymous");
    assert.equal(batch.counts!.get(id("main")), expectedCount, actor?.id ?? "anonymous");
    assert.ok(previewIds(batch, id("main")).every((commentId) => commentId !== id("synthetic-unmarked")));
  }
});

test("AI fallback appears only with zero visible human top-level comments", { skip: !ENABLED }, async () => {
  const cases: Array<[Actor | null, string[], number]> = [
    [null, [id("ai-only-new")], 2],
    [realA, [id("ai-pending-own")], 3],
    [realB, [id("ai-only-new")], 2],
    [moderator, [id("ai-pending-own"), id("ai-rejected")], 4],
  ];
  for (const [actor, expectedPreview, expectedCount] of cases) {
    const batch = await loadFeedCommentBatch([id("ai")], actor, id("load"), undefined, { aiPreview: true });
    assert.deepEqual(previewIds(batch, id("ai")), expectedPreview, actor?.id ?? "anonymous");
    assert.equal(batch.counts!.get(id("ai")), expectedCount, actor?.id ?? "anonymous");
  }
});

test("with the site flag off, AI comments leave both previews and counts", { skip: !ENABLED }, async () => {
  // 默认口径：AI 不进预览，也不进「N 条回复」。这两个断言必须同生同死——
  // 只要计数还含 AI，卡片就会出现「N 条回复」+「没有可预览的顶层回复」。
  for (const actor of [null, realB] as const) {
    const batch = await loadFeedCommentBatch([id("ai")], actor, id("load"));
    assert.deepEqual(previewIds(batch, id("ai")), [], actor?.id ?? "anonymous");
    assert.equal(batch.counts!.get(id("ai")) ?? 0, 0, actor?.id ?? "anonymous");
  }
});

test("PostgreSQL truncates at 1024 code points, not UTF-16 units", { skip: !ENABLED }, async () => {
  const batch = await loadFeedCommentBatch([id("long")], null, id("load"));
  const rows = batch.previews!.get(id("long"))!;
  assert.deepEqual(rows.map((row) => row.id), [id("long"), id("exact")]);
  assert.equal(Array.from(rows[0].content).length, 1024);
  assert.equal(rows[0].contentTruncated, true);
  assert.equal(rows[0].content.endsWith("尾部"), false);
  assert.equal(Array.from(rows[1].content).length, 1024);
  assert.equal(rows[1].contentTruncated, false);
});

test("N=24/30/300 use two loader reads and bound candidate/final/count rows", { skip: !ENABLED }, async () => {
  // 两种口径都跑：关闭态是生产默认（AI 分支不进 SQL），打开态是后台开关打开后的形状。
  for (const aiPreview of [false, true]) {
    const options = { aiPreview };
    const perArticle = aiPreview ? 3 : 2;
    for (const n of [24, 30, 300]) {
      const ids = bulkIds.slice(0, n);
      let dataReads = 0;
      const batch = await loadFeedCommentBatch(ids, null, id("load"), {
        previews: () => {
          dataReads += 1;
          return readPreviewCandidates(ids, null, options);
        },
        counts: () => {
          dataReads += 1;
          return readVisibleCounts(ids, null, options);
        },
      }, options);
      const candidates = await readFeedCommentCandidates(ids, null, options);
      assert.equal(dataReads, 2, `N=${n} aiPreview=${aiPreview} loader data reads`);
      assert.equal(candidates.length, perArticle * n, `N=${n} aiPreview=${aiPreview} candidate rows`);
      assert.equal([...batch.previews!.values()].flat().length, 2 * n, `N=${n} aiPreview=${aiPreview} final rows`);
      assert.equal(batch.counts!.size, n, `N=${n} aiPreview=${aiPreview} count groups`);
      assert.ok([...batch.counts!.values()].every((count) => count === perArticle), `N=${n} aiPreview=${aiPreview} counts`);
    }
  }
});

async function makeComment(
  name: string,
  options: {
    articleId?: string;
    parentId?: string | null;
    authorId?: string;
    status?: string;
    origin?: string | null;
    content?: string;
  } = {},
) {
  return prisma.comment.create({
    data: {
      id: id(name),
      articleId: options.articleId ?? id("write"),
      parentId: options.parentId ?? null,
      authorId: options.authorId ?? realA.id,
      status: options.status ?? "published",
      origin: options.origin === undefined ? "human" : options.origin,
      content: options.content ?? "synthetic parent comment",
      images: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
}

function writeInput(parentId: string, content = "这是一条有效的内联回复"): FeedCommentInput {
  return {
    articleId: id("write"), parentId, content, images: [], surface: "feed",
  };
}

interface PgClient {
  connect(): Promise<void>;
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
}

async function connectPg(): Promise<PgClient> {
  const moduleName = "pg";
  const { Client } = await import(moduleName) as {
    Client: new (options: { connectionString: string | undefined }) => PgClient;
  };
  const client = new Client({ connectionString: TEST_URL });
  await client.connect();
  return client;
}

async function waitForActivity(
  client: PgClient,
  kind: "parent-lock" | "insert-sleep" | "change-lock",
): Promise<number> {
  const predicates = {
    "parent-lock": "wait_event_type = 'Lock'",
    "insert-sleep": "wait_event_type = 'Timeout' AND position('INSERT INTO' in query) > 0 AND position('comments' in query) > 0",
    "change-lock": "wait_event_type = 'Lock'",
  };
  const deadline = Date.now() + 1800;
  while (Date.now() < deadline) {
    const result = await client.query<{ pid: number }>(`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND ${predicates[kind]}
      ORDER BY pid LIMIT 1
    `);
    if (result.rows[0]) return result.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${kind}`);
}

test("locked creation enforces target and shared parent visibility", { skip: !ENABLED }, async () => {
  const visible = await makeComment("write-visible");
  const created = await createFeedCommentWithVisibleParent({
    input: writeInput(visible.id), actor: realC, publish: true,
  });
  assert.equal(created.comment.parentId, visible.id);
  assert.equal(created.comment.authorId, realC.id);
  assert.equal(created.parentAuthorSynthetic, false);

  const aiParent = await makeComment("write-ai-parent", {
    authorId: bot.id, origin: "ai_autonomous",
  });
  const aiReply = await createFeedCommentWithVisibleParent({
    input: writeInput(aiParent.id), actor: realC, publish: false,
  });
  assert.equal(aiReply.comment.status, "pending_review");
  assert.equal(aiReply.parentAuthorSynthetic, true);

  const ownPending = await makeComment("write-own-pending", { status: "pending_review" });
  const ownReply = await createFeedCommentWithVisibleParent({
    input: writeInput(ownPending.id), actor: realA, publish: true,
  });
  assert.equal(ownReply.comment.parentId, ownPending.id);

  const rejected = await makeComment("write-rejected", { status: "rejected" });
  const moderatorReply = await createFeedCommentWithVisibleParent({
    input: writeInput(rejected.id), actor: moderator, publish: true,
  });
  assert.equal(moderatorReply.comment.parentId, rejected.id);

  const hiddenSynthetic = await makeComment("write-hidden-synthetic", {
    authorId: bot.id, origin: null,
  });
  const otherPending = await makeComment("write-other-pending", {
    authorId: realB.id, status: "pending_review",
  });
  for (const [parentId, actor] of [
    [hiddenSynthetic.id, realC],
    [otherPending.id, realC],
    [rejected.id, syntheticAdmin],
    [visible.id, realC],
    [id("missing-parent"), realC],
  ] as const) {
    const articleId = parentId === visible.id ? id("main") : id("write");
    await assert.rejects(
      createFeedCommentWithVisibleParent({
        input: { ...writeInput(parentId), articleId }, actor, publish: true,
      }),
      ParentCommentConflict,
    );
  }
  assert.equal(await prisma.comment.count({
    where: { parentId: { in: [hiddenSynthetic.id, otherPending.id] } },
  }), 0);
});

test("self-relation SET NULL and actual user/admin deletes preserve children as roots", { skip: !ENABLED }, async (t) => {
  if (skipWithoutModuleMocks(t)) return;
  const foreignKeys = await prisma.$queryRaw<Array<{ conname: string; confdeltype: string }>>`
    SELECT conname, confdeltype FROM pg_constraint
    WHERE conrelid = 'comments'::regclass AND confrelid = 'comments'::regclass
      AND contype = 'f'
  `;
  assert.equal(foreignKeys.length, 1);
  assert.equal(foreignKeys[0].confdeltype, "n", "SET NULL: deletion promotes children to roots");

  sessionUser = realA;
  t.mock.module("@/lib/auth", {
    namedExports: { auth: async () => (sessionUser ? { user: sessionUser } : null) },
  });
  const userRoute = await import("../app/api/comments/[id]/route.ts");
  const adminRoute = await import("../app/api/admin/comments/[id]/route.ts");
  const request = () => new Request("http://127.0.0.1/api/comments/test", {
    method: "DELETE",
  }) as unknown as NextRequest;
  const params = (commentId: string) => ({ params: Promise.resolve({ id: commentId }) });

  const userParent = await makeComment("delete-user-parent");
  const userChild = await makeComment("delete-user-child", {
    parentId: userParent.id, authorId: realC.id,
  });
  sessionUser = realA;
  const userParentResponse = await userRoute.DELETE(request(), params(userParent.id));
  assert.equal(userParentResponse.status, 200);
  assert.equal(await prisma.comment.findUnique({ where: { id: userParent.id } }), null);
  assert.equal((await prisma.comment.findUnique({ where: { id: userChild.id } }))!.parentId, null);

  const adminParent = await makeComment("delete-admin-parent");
  const adminChild = await makeComment("delete-admin-child", {
    parentId: adminParent.id, authorId: realC.id,
  });
  sessionUser = realAdmin;
  const adminParentResponse = await adminRoute.DELETE(request(), params(adminParent.id));
  assert.equal(adminParentResponse.status, 200);
  assert.equal(await prisma.comment.findUnique({ where: { id: adminParent.id } }), null);
  assert.equal((await prisma.comment.findUnique({ where: { id: adminChild.id } }))!.parentId, null);

  await prisma.article.update({ where: { id: id("write") }, data: { replyCount: 2 } });
  sessionUser = realC;
  const userResponse = await userRoute.DELETE(request(), params(userChild.id));
  assert.equal(userResponse.status, 200);
  assert.equal((await prisma.article.findUnique({ where: { id: id("write") } }))!.replyCount, 1);

  sessionUser = realAdmin;
  const adminResponse = await adminRoute.DELETE(request(), params(adminChild.id));
  assert.equal(adminResponse.status, 200);
  assert.equal(await prisma.comment.count({ where: { id: { in: [userChild.id, adminChild.id] } } }), 0);
});

test("two-connection hide/delete races and connection kill preserve atomicity", { skip: !ENABLED }, async () => {
  const clients: PgClient[] = [];
  const connect = async () => {
    const client = await connectPg();
    clients.push(client);
    return client;
  };
  try {
    const control = await connect();
    await control.query(`
      CREATE OR REPLACE FUNCTION feed_inline_test_pause() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.content LIKE 'pause-before-insert%' THEN PERFORM pg_sleep(0.5); END IF;
        IF NEW.content LIKE 'pause-after-insert%' THEN PERFORM pg_sleep(0.8); END IF;
        RETURN NEW;
      END
      $function$
    `);
    await control.query("DROP TRIGGER IF EXISTS feed_inline_test_pause_after ON comments");
    await control.query("DROP TRIGGER IF EXISTS feed_inline_test_pause ON comments");
    await control.query(`
      CREATE TRIGGER feed_inline_test_pause BEFORE INSERT ON comments
      FOR EACH ROW EXECUTE FUNCTION feed_inline_test_pause()
    `);
    // A second trigger fires after insertion, allowing a killed uncommitted child test.
    await control.query(`
      CREATE TRIGGER feed_inline_test_pause_after AFTER INSERT ON comments
      FOR EACH ROW EXECUTE FUNCTION feed_inline_test_pause()
    `);

    const hiddenBefore = await makeComment("race-hidden-before");
    await control.query("BEGIN");
    await control.query("SELECT id FROM comments WHERE id = $1 FOR UPDATE", [hiddenBefore.id]);
    const hiddenWrite = createFeedCommentWithVisibleParent({
      input: writeInput(hiddenBefore.id), actor: realC, publish: true,
    });
    await waitForActivity(control, "parent-lock");
    await control.query("UPDATE comments SET status = 'rejected' WHERE id = $1", [hiddenBefore.id]);
    await control.query("COMMIT");
    await assert.rejects(hiddenWrite, ParentCommentConflict);
    assert.equal(await prisma.comment.count({ where: { parentId: hiddenBefore.id } }), 0);

    const deletedBefore = await makeComment("race-deleted-before");
    await control.query("BEGIN");
    await control.query("SELECT id FROM comments WHERE id = $1 FOR UPDATE", [deletedBefore.id]);
    const deletedWrite = createFeedCommentWithVisibleParent({
      input: writeInput(deletedBefore.id), actor: realC, publish: true,
    });
    await waitForActivity(control, "parent-lock");
    await control.query("DELETE FROM comments WHERE id = $1", [deletedBefore.id]);
    await control.query("COMMIT");
    await assert.rejects(deletedWrite, ParentCommentConflict);
    assert.equal(await prisma.comment.count({ where: { parentId: deletedBefore.id } }), 0);

    const hiddenAfter = await makeComment("race-hidden-after");
    const afterHideWrite = createFeedCommentWithVisibleParent({
      input: writeInput(hiddenAfter.id, "pause-before-insert hide after lock"),
      actor: realC,
      publish: true,
    });
    await waitForActivity(control, "insert-sleep");
    const hider = await connect();
    const hide = hider.query("UPDATE comments SET status = 'rejected' WHERE id = $1", [hiddenAfter.id]);
    await waitForActivity(control, "change-lock");
    await afterHideWrite;
    await hide;
    assert.equal(await prisma.comment.count({ where: { parentId: hiddenAfter.id } }), 1);
    assert.equal((await prisma.comment.findUnique({ where: { id: hiddenAfter.id } }))!.status, "rejected");

    const deletedAfter = await makeComment("race-deleted-after");
    const afterDeleteWrite = createFeedCommentWithVisibleParent({
      input: writeInput(deletedAfter.id, "pause-before-insert delete after lock"),
      actor: realC,
      publish: true,
    });
    await waitForActivity(control, "insert-sleep");
    const deleter = await connect();
    const deletion = deleter.query("DELETE FROM comments WHERE id = $1", [deletedAfter.id]).then(
      () => null,
      (error: unknown) => error,
    );
    await waitForActivity(control, "change-lock");
    await afterDeleteWrite;
    assert.equal(await deletion, null);
    assert.equal(await prisma.comment.count({ where: { parentId: deletedAfter.id } }), 0);
    assert.equal(await prisma.comment.findUnique({ where: { id: deletedAfter.id } }), null);
    assert.equal((await prisma.comment.findFirst({
      where: { articleId: id("write"), content: "pause-before-insert delete after lock" },
    }))?.parentId, null);

    const rollbackParent = await makeComment("race-rollback-parent");
    const killedWrite = createFeedCommentWithVisibleParent({
      input: writeInput(rollbackParent.id, "pause-after-insert kill uncommitted child"),
      actor: realC,
      publish: true,
    });
    const writerPid = await waitForActivity(control, "insert-sleep");
    await control.query("SELECT pg_terminate_backend($1)", [writerPid]);
    await assert.rejects(killedWrite);
    assert.equal(await prisma.comment.count({ where: { parentId: rollbackParent.id } }), 0);
    assert.ok(await prisma.comment.findUnique({ where: { id: rollbackParent.id } }));
  } finally {
    for (const client of clients) {
      await client.query("DROP TRIGGER IF EXISTS feed_inline_test_pause_after ON comments").catch(() => {});
      await client.query("DROP TRIGGER IF EXISTS feed_inline_test_pause ON comments").catch(() => {});
      await client.end().catch(() => {});
    }
  }
});

test("feed route matrix keeps stable problems, gate-off writes and legacy detail behavior", { skip: !ENABLED }, async (t) => {
  if (skipWithoutModuleMocks(t)) return;
  const REQUEST_ID = "8b95a102-96b7-4ebf-9b2b-35c2601ef027";
  const originalGate = process.env.FEED_INLINE_REPLIES;
  let moderationMode: "publish" | "reject" | "throw" = "publish";
  let effectsThrow = false;
  sessionUser = realA;
  t.mock.module("@/lib/auth", {
    namedExports: { auth: async () => (sessionUser ? { user: sessionUser } : null) },
  });
  t.mock.module("@/lib/moderation", {
    namedExports: {
      screenContent: async () => {
        if (moderationMode === "throw") throw new Error("synthetic moderation outage");
        return moderationMode === "reject"
          ? { decision: "reject", categories: ["synthetic"], confidence: 0.9, reason: "synthetic", source: "mock" }
          : { decision: "publish", categories: [], confidence: 1, reason: "synthetic", source: "mock" };
      },
    },
  });
  t.mock.module("@/lib/comment-effects", {
    namedExports: {
      publishCommentEffects: async () => {
        if (effectsThrow) throw new Error("synthetic post-create effects outage");
      },
    },
  });

  const { POST } = await import("../app/api/comments/route.ts");
  // The feed card has no root composer, so every feed payload answers a real
  // comment. This parent is visible to realA on the write article.
  const routeParent = await makeComment("route-parent");
  const payload = (overrides: Record<string, unknown> = {}) => ({
    articleId: id("write"),
    content: `route synthetic reply ${Date.now()}`,
    parentId: routeParent.id,
    images: [],
    surface: "feed",
    ...overrides,
  });
  // The matrix makes more than LIMIT_POST (10/hour) writes as one user. The
  // limiter is keyed on IP+user and is not what this matrix tests, so give each
  // request its own client IP instead of letting the 11th write answer 429.
  let requestSeq = 0;
  const request = (
    body: unknown,
    options: { problem?: boolean; requestId?: string; ip?: string; text?: string } = {},
  ) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Real-IP": options.ip ?? `127.0.1.${++requestSeq}`,
    };
    if (options.problem !== false) headers.Accept = "application/problem+json";
    if (options.requestId) headers["X-Request-ID"] = options.requestId;
    return new Request("http://127.0.0.1/api/comments", {
      method: "POST", headers, body: options.text ?? JSON.stringify(body),
    }) as unknown as NextRequest;
  };
  const expectProblem = async (response: Response, status: number, code: string) => {
    assert.equal(response.status, status);
    assert.match(response.headers.get("content-type") ?? "", /application\/problem\+json/);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.code, code);
    assert.equal(body.status, status);
    assert.equal(body.requestId, response.headers.get("x-request-id"));
    assert.equal(JSON.stringify(body).includes("stack"), false);
    return body;
  };

  try {
    process.env.FEED_INLINE_REPLIES = "0";
    sessionUser = null; // A disabled surface is 404 for anonymous probes too.
    const disabled = await POST(request(payload({ content: "gate must create nothing" }), { requestId: REQUEST_ID }));
    const disabledBody = await expectProblem(disabled, 404, "comment.feed_disabled");
    assert.equal(disabledBody.requestId, REQUEST_ID);
    assert.equal(await prisma.comment.count({ where: { content: "gate must create nothing" } }), 0);

    // Accept must not define the surface: the same feed write sent with a
    // legacy Accept header is still rejected before auth.
    const disabledLegacyAccept = await POST(
      request(payload({ content: "gate off legacy accept" }), { problem: false }),
    );
    assert.equal(disabledLegacyAccept.status, 404);
    assert.equal(await prisma.comment.count({ where: { content: "gate off legacy accept" } }), 0);

    process.env.FEED_INLINE_REPLIES = "1";
    sessionUser = null;
    await expectProblem(await POST(request(payload())), 401, "comment.unauthenticated");
    sessionUser = realA;

    await expectProblem(await POST(request(payload({ content: "短" }))), 400, "comment.invalid_input");
    await expectProblem(await POST(request(payload({ parentId: null }))), 400, "comment.invalid_input");
    await expectProblem(await POST(request(payload({ parentId: "   " }))), 400, "comment.invalid_input");
    await expectProblem(await POST(request(payload({ images: ["https://example.invalid/image.jpg"] }))), 400, "comment.invalid_input");

    // A problem client can send a literal `null`, an array or a primitive. These
    // must answer invalid_input instead of being destructured into a 500.
    await expectProblem(await POST(request(null)), 400, "comment.invalid_input");
    await expectProblem(await POST(request([payload()])), 400, "comment.invalid_input");
    await expectProblem(await POST(request("feed")), 400, "comment.invalid_input");

    const crossParent = await makeComment("route-cross-parent", { articleId: id("main") });
    await expectProblem(
      await POST(request(payload({ parentId: crossParent.id }))),
      409,
      "comment.parent_conflict",
    );
    assert.equal(await prisma.comment.count({ where: { parentId: crossParent.id } }), 0);

    // A write target the actor cannot open on the detail page is refused even
    // when the parent comment itself is visible.
    const pendingArticleId = id("route-pending-article");
    await prisma.article.create({
      data: {
        id: pendingArticleId,
        type: "discussion",
        title: "Synthetic pending article",
        content: "Synthetic pending article",
        tags: [],
        images: [],
        status: "pending_review",
        visibility: "public",
        origin: "human",
        authorId: realB.id,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    const pendingArticleParent = await makeComment("route-pending-parent", {
      articleId: pendingArticleId, authorId: realB.id,
    });
    await expectProblem(
      await POST(request(payload({ articleId: pendingArticleId, parentId: pendingArticleParent.id }))),
      409,
      "comment.parent_conflict",
    );
    assert.equal(await prisma.comment.count({ where: { parentId: pendingArticleParent.id } }), 0);

    moderationMode = "reject";
    await expectProblem(await POST(request(payload())), 400, "comment.moderation_rejected");
    moderationMode = "throw";
    const moderationUnknown = await expectProblem(
      await POST(request(payload())),
      500,
      "comment.outcome_unknown",
    );
    assert.equal(moderationUnknown.sideEffects, "unknown");
    assert.equal(moderationUnknown.recovery, "detail");

    moderationMode = "publish";
    effectsThrow = true;
    const effectsUnknownContent = `effects unknown ${Date.now()}`;
    const effectsUnknown = await expectProblem(
      await POST(request(payload({ content: effectsUnknownContent }))),
      500,
      "comment.outcome_unknown",
    );
    assert.equal(effectsUnknown.sideEffects, "unknown");
    assert.equal(await prisma.comment.count({ where: { content: effectsUnknownContent } }), 1);

    effectsThrow = false;
    const legacyContent = `legacy detail ${Date.now()}`;
    const legacyResponse = await POST(request({
      articleId: id("write"), content: legacyContent, images: [],
    }, { problem: false }));
    assert.equal(legacyResponse.status, 201);
    const legacyBody = await legacyResponse.json() as Record<string, unknown>;
    assert.equal(legacyBody.pendingReview, false);
    assert.equal(legacyBody.content, legacyContent);
    assert.equal(await prisma.comment.count({ where: { content: legacyContent } }), 1);

    // Legacy detail path: a problem+json Accept without `surface` is still the
    // legacy detail write — dispatch is keyed on the body, not the header.
    const legacyProblemAcceptContent = `legacy problem accept ${Date.now()}`;
    const legacyProblemAccept = await POST(request({
      articleId: id("write"), content: legacyProblemAcceptContent, images: [],
    }));
    assert.equal(legacyProblemAccept.status, 201);

    const legacyHiddenParent = await makeComment("legacy-hidden-parent", {
      authorId: realB.id, status: "pending_review",
    });
    const legacyHidden = await POST(request({
      articleId: id("write"), parentId: legacyHiddenParent.id,
      content: "legacy hidden parent reply", images: [],
    }, { problem: false }));
    assert.equal(legacyHidden.status, 409);
    assert.equal(await prisma.comment.count({ where: { parentId: legacyHiddenParent.id } }), 0);

    const legacyVisibleContent = `legacy visible parent ${Date.now()}`;
    const legacyVisible = await POST(request({
      articleId: id("write"), parentId: routeParent.id, content: legacyVisibleContent, images: [],
    }, { problem: false }));
    assert.equal(legacyVisible.status, 201);
    assert.equal(await prisma.comment.count({ where: { content: legacyVisibleContent } }), 1);

    const legacyMissingArticle = await POST(request({
      articleId: id("missing-article"), content: "legacy missing article reply", images: [],
    }, { problem: false }));
    assert.equal(legacyMissingArticle.status, 404);
    assert.equal(await prisma.comment.count({ where: { content: "legacy missing article reply" } }), 0);

    // Legacy detail path: malformed JSON and a literal `null` body are definite
    // 400s. The gate-on clone probe runs first here, so this also proves the
    // probe leaves the original body readable on a parse error.
    const legacyBadJson = await POST(request(null, { problem: false, text: "{" }));
    assert.equal(legacyBadJson.status, 400);
    const legacyNullBody = await POST(request(null, { problem: false }));
    assert.equal(legacyNullBody.status, 400);

    await expectProblem(await POST(request(null, { text: "{" })), 400, "comment.invalid_json");

    // Declared oversize is refused before the body is read, and the problem
    // names the bound so a client can shrink the payload instead of guessing.
    const oversized = await expectProblem(
      await POST(request(payload({ pad: "x".repeat(FEED_COMMENT_LIMITS.maxBodyBytes) }))),
      413,
      "comment.invalid_input",
    );
    assert.deepEqual(oversized.context, {
      field: "content", unit: "bytes", limit: FEED_COMMENT_LIMITS.maxBodyBytes,
    });

    // The legacy detail path has no body bound (deferred), but the probe's
    // mid-stream cancel must not strand the original body: either it still
    // parses (201) or it answers a definite 400 — never a hang or a 500.
    const legacyOversized = await POST(request({
      articleId: id("write"), content: "legacy oversized body", images: [],
      pad: "x".repeat(FEED_COMMENT_LIMITS.maxBodyBytes),
    }, { problem: false }));
    assert.ok(
      legacyOversized.status === 201 || legacyOversized.status === 400,
      `legacy oversized body answered ${legacyOversized.status}`,
    );

    // One client IP, one window: LIMIT_POST writes pass, the next is refused
    // with the wait spelled out in Retry-After. The payloads are invalid on
    // purpose — the limiter runs before validation, so this costs no rows.
    const limitedIp = "127.0.9.9";
    for (let n = 0; n < LIMIT_POST.max; n++) {
      const withinWindow = await POST(request(payload({ content: "短" }), { ip: limitedIp }));
      assert.equal(withinWindow.status, 400, `write ${n + 1} of ${LIMIT_POST.max} within the window`);
    }
    const limited = await POST(request(payload({ content: "短" }), { ip: limitedIp }));
    await expectProblem(limited, 429, "comment.rate_limited");
    const retryAfter = Number(limited.headers.get("retry-after"));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, `Retry-After header: ${retryAfter}`);
  } finally {
    if (originalGate === undefined) delete process.env.FEED_INLINE_REPLIES;
    else process.env.FEED_INLINE_REPLIES = originalGate;
    sessionUser = null;
  }
});


