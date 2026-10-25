import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DELTAS, STAGES } from "./tasting-extract/vocab.ts";
import { MAX_REMIND_MONTHS, STORAGE_SCORE_MAX, STORAGE_SCORE_MIN } from "./cellar.ts";

/**
 * 「两层都挡住才算数 —— 应用层会漂移，约束不会。」
 *
 * 仓储评分、阶段、对照这些口径在**三处**各写了一遍：DB 的 CHECK 约束、
 * zod 的 schema、以及词表本身。改了一处忘了另一处，症状是
 * 「应用层接受了、数据库拒了」—— 生产上表现为一个 500，而单测全绿。
 *
 * 这个测试把 SQL 读出来跟词表/常量对一遍 —— 便宜，且能挡住漂移。
 */

const SQL = readFileSync(
  new URL("../../prisma/migrations/20261023_cellar/migration.sql", import.meta.url),
  "utf8",
);

test("DB 的储仓评分范围与应用层一致", () => {
  assert.match(
    SQL,
    new RegExp(
      `"storageScore" IS NULL OR "storageScore" BETWEEN ${STORAGE_SCORE_MIN} AND ${STORAGE_SCORE_MAX}`,
    ),
  );
});

test("DB 的阶段 CHECK 与词表 STAGES 一致", () => {
  const expected = STAGES.map((s) => `'${s}'`).join(", ");
  assert.match(
    SQL,
    new RegExp(`"stage" IS NULL OR "stage" IN \\(${expected}\\)`),
    "词表加了新阶段，DB 的 CHECK 也要跟着加",
  );
});

test("DB 的对照 CHECK 与词表 DELTAS 一致", () => {
  const expected = DELTAS.map((d) => `'${d}'`).join(", ");
  assert.match(
    SQL,
    new RegExp(`"deltaVsPrev" IS NULL OR "deltaVsPrev" IN \\(${expected}\\)`),
    "词表加了新对照，DB 的 CHECK 也要跟着加",
  );
});

test("DB 的可见性枚举只有 private / shared", () => {
  assert.match(SQL, /"visibility" IN \('private', 'shared'\)/);
});

test("DB 的耗时下界与应用层一致", () => {
  assert.match(
    SQL,
    /"elapsedSeconds" IS NULL OR "elapsedSeconds" >= 0/,
  );
});

test("DB 的提醒间隔范围与应用层一致", () => {
  assert.match(SQL, /"remindEveryMonths" BETWEEN 1 AND 60/, "老迁移是历史，别去改它");
});

// ─── 复饮提醒迁移（F4）────────────────────────────────────────────────────

const REMINDERS_SQL = readFileSync(
  new URL(
    "../../prisma/migrations/20261025_cellar_reminders/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

test("提醒间隔的下界放宽到 0（0 = 不提醒），与应用层一致", () => {
  assert.match(
    REMINDERS_SQL,
    new RegExp(`"remindEveryMonths" BETWEEN 0 AND ${MAX_REMIND_MONTHS}`),
    "应用层放行 0，DB 也要放行 —— 否则是一个 500（两层都要挡住才算数）",
  );
  assert.match(
    REMINDERS_SQL,
    /DROP CONSTRAINT IF EXISTS "cellar_items_remindEveryMonths_check"/,
    "老约束是 1..60，必须先删再加，否则线上约束还是老的",
  );
});

test("提醒迁移加了 lastRemindedAt 与 nextRemindAt 的索引", () => {
  assert.match(REMINDERS_SQL, /ADD COLUMN IF NOT EXISTS "lastRemindedAt"/);
  assert.match(
    REMINDERS_SQL,
    /CREATE INDEX IF NOT EXISTS "cellar_items_nextRemindAt_idx"/,
    "跑批每天扫「到期」的条目，没有索引就是全表扫",
  );
});

test("提醒迁移是幂等的", () => {
  const adds = REMINDERS_SQL.match(/ALTER TABLE "[a-z_]+" ADD CONSTRAINT/g) ?? [];
  const guards = REMINDERS_SQL.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g) ?? [];
  assert.equal(
    guards.length,
    adds.length,
    "每个 ADD CONSTRAINT 都要有对应的 pg_constraint 守卫，否则重跑会失败",
  );
  assert.match(REMINDERS_SQL, /DROP CONSTRAINT IF EXISTS/);
});

test("提醒迁移设了锁超时", () => {
  assert.match(REMINDERS_SQL, /SET lock_timeout = '3s';/);
  const lockAt = REMINDERS_SQL.indexOf("SET lock_timeout");
  const alterAt = REMINDERS_SQL.search(/^ALTER TABLE /m);
  assert.ok(lockAt !== -1, "迁移里应该设了 lock_timeout");
  assert.ok(alterAt !== -1, "迁移里应该有 ALTER");
  assert.ok(lockAt < alterAt, "lock_timeout 要在 ALTER 之前");
});

test("提醒迁移回填了存量条目的 nextRemindAt", () => {
  assert.match(
    REMINDERS_SQL,
    /UPDATE "cellar_items" ci\s+SET "nextRemindAt"/,
    "不回填的话存量条目永远扫不到（nextRemindAt 是 NULL）",
  );
});

test("DB 的词库来源枚举是封闭的（其它枚举列都有 CHECK，它不该是例外）", () => {
  assert.match(SQL, /"source" IN \('seed', 'llm', 'editor'\)/);
});

test("迁移是幂等的：加约束的地方都用 pg_constraint 包了一层", () => {
  // Postgres 的 ADD CONSTRAINT 没有 IF NOT EXISTS —— 不包一层的话，
  // 第二次执行迁移就会报错中断。
  const adds = SQL.match(/ALTER TABLE "[a-z_]+" ADD CONSTRAINT/g) ?? [];
  assert.ok(adds.length > 0, "迁移里应该有加约束的语句");
  const guards = SQL.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g) ?? [];
  assert.equal(
    guards.length,
    adds.length,
    "每个 ADD CONSTRAINT 都要有对应的 pg_constraint 守卫，否则重跑会失败",
  );
});

test("迁移给 users 加列前设了锁超时（否则会排在长事务后面，把登录全堵住）", () => {
  assert.match(SQL, /SET lock_timeout = '3s';/);
  // 找的是**可执行**的那条 ALTER（文件头的回滚说明里也有一句 ALTER TABLE "users"，
  // 拿它比会得出错误结论）。
  const lockAt = SQL.indexOf("SET lock_timeout");
  const alterAt = SQL.indexOf('ALTER TABLE "users"\n  ADD COLUMN');
  assert.ok(lockAt !== -1, "迁移里应该设了 lock_timeout");
  assert.ok(alterAt !== -1, "迁移里应该给 users 加列");
  assert.ok(lockAt < alterAt, "lock_timeout 要在 ALTER 之前");
});

// ─── 品鉴媒体迁移（dimTags / videos）─────────────────────────────────────

const MEDIA_SQL = readFileSync(
  new URL(
    "../../prisma/migrations/20261024_cellar_tasting_media/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

test("品鉴媒体迁移加的是 dimTags 与 videos 两列", () => {
  assert.match(MEDIA_SQL, /ADD COLUMN IF NOT EXISTS "dimTags" JSONB/);
  assert.match(MEDIA_SQL, /ADD COLUMN IF NOT EXISTS "videos" JSONB/);
});

test("品鉴媒体迁移是幂等的（重跑不会失败）", () => {
  // 只数**真正执行的语句**（行首的 ALTER TABLE），注释里提到的不算。
  const statements = MEDIA_SQL.match(/^ALTER TABLE .*$/gm) ?? [];
  assert.equal(statements.length, 2, "两列");
  for (const s of statements) {
    assert.match(s, /ADD COLUMN IF NOT EXISTS/, `裸的 ADD COLUMN 重跑会报错：${s}`);
  }
});

test("品鉴媒体迁移给 dimTags 与 videos 都加了 CHECK 约束", () => {
  // 「两层都挡住才算数」：zod 挡一层，DB 再挡一层。
  assert.match(
    MEDIA_SQL,
    /ADD CONSTRAINT "cellar_tastings_dimTags_check"/,
    "dimTags 要有 CHECK 约束",
  );
  assert.match(
    MEDIA_SQL,
    /ADD CONSTRAINT "cellar_tastings_videos_check"/,
    "videos 要有 CHECK 约束",
  );
  // 加约束的地方都要用 pg_constraint 包一层，否则重跑会失败
  const adds =
    MEDIA_SQL.match(/ADD CONSTRAINT "[a-zA-Z_]+"/g) ?? [];
  const guards = MEDIA_SQL.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g) ?? [];
  assert.equal(
    guards.length,
    adds.length,
    "每个 ADD CONSTRAINT 都要有对应的 pg_constraint 守卫",
  );
});

test("品鉴媒体迁移给「按 userId 找 createdAt 最新一条」加了索引", () => {
  // 24 小时间隔闸门每次都要这个查询 —— 没有索引就是全表扫。
  assert.match(
    MEDIA_SQL,
    /CREATE INDEX IF NOT EXISTS "cellar_tastings_userId_createdAt_idx"/,
  );
});

test("品鉴媒体迁移设了锁超时（ALTER 会排在长事务后面）", () => {
  assert.match(MEDIA_SQL, /SET lock_timeout = '3s';/);
  const lockAt = MEDIA_SQL.indexOf("SET lock_timeout");
  // 第一条**可执行**的 ALTER（注释里也提到 ALTER TABLE，不能拿它比）。
  const alterAt = MEDIA_SQL.search(/^ALTER TABLE /m);
  assert.ok(lockAt !== -1, "迁移里应该设了 lock_timeout");
  assert.ok(alterAt !== -1, "迁移里应该有 ALTER");
  assert.ok(lockAt < alterAt, "lock_timeout 要在 ALTER 之前");
});
