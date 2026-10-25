-- F4 复饮提醒（PRD v0.3 §7 Phase 4）
--
-- 目标：让「每 N 个月提醒我复饮一次」真的跑起来。
--
-- 背景：20261023_cellar 建表时就把 remindEveryMonths / nextRemindAt 留好了，
-- 但**没有任何代码算过 nextRemindAt，也没有任务会发提醒** —— 字段躺着，
-- 功能等于没有。本迁移补上三样东西：
--
--   1. lastRemindedAt —— 「上次提醒过没有」。没有它就无法幂等：跑批每天
--      跑一次，没有它就会天天重复提醒同一条。
--   2. nextRemindAt 的索引 —— 跑批每天要扫「到期」的条目。
--   3. remindEveryMonths 的 CHECK 放宽到 0..60 —— **0 = 不提醒**。
--      用户总得有个「别再提醒我」的开关（1..60 时做不到）。
--
-- 口径（唯一实现见 src/lib/cellar-reminder.ts）：
--   anchor        = 最近一次品鉴的**服务端 createdAt**（按同一条茶跨条目）
--                    → acquiredAt → createdAt
--   nextRemindAt  = max( anchor + N 个月 , lastRemindedAt + N 个月 )
--   N = remindEveryMonths（0 → 不提醒，nextRemindAt 为空）
--
-- 部署顺序：**先执行本 SQL，再部署带新代码的镜像**（Prisma 生成的 Client
-- 需要新列存在）。脚本幂等，重复执行安全。
--
-- 回滚：ALTER TABLE "cellar_items" DROP COLUMN "lastRemindedAt";
--       DROP INDEX IF EXISTS "cellar_items_nextRemindAt_idx";

-- 锁超时：ALTER TABLE 要拿 ACCESS EXCLUSIVE 锁。没有 lock_timeout 时，它会
-- 排在任何已持有 cellar_items 锁的长事务后面。3 秒拿不到锁就失败退出，
-- 等一会儿重跑即可（脚本幂等）。
SET lock_timeout = '3s';

-- ─── 1. lastRemindedAt + nextRemindAt 索引 ──────────────────────────────

ALTER TABLE "cellar_items"
  ADD COLUMN IF NOT EXISTS "lastRemindedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "cellar_items_nextRemindAt_idx"
  ON "cellar_items" ("nextRemindAt");

-- ─── 2. remindEveryMonths 的 CHECK 放宽到 0..60（0 = 不提醒）─────────────
--
-- 老约束是 1..60（见 20261023_cellar）。要允许 0 就得先删再加 —— 删约束
-- 也要 ACCESS EXCLUSIVE 锁，同样受 lock_timeout 保护。
--
-- 注意：**不要去改 20261023_cellar/migration.sql**（那是历史，线上已执行过）。
DO $$
BEGIN
  ALTER TABLE "cellar_items" DROP CONSTRAINT IF EXISTS "cellar_items_remindEveryMonths_check";
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cellar_items_remindEveryMonths_check') THEN
    ALTER TABLE "cellar_items" ADD CONSTRAINT "cellar_items_remindEveryMonths_check"
      CHECK ("remindEveryMonths" BETWEEN 0 AND 60);
  END IF;
END $$;

-- ─── 3. 回填存量条目的 nextRemindAt ────────────────────────────────────
--
-- 口径与 src/lib/cellar-reminder.ts 一致（跨条目取同一条茶的最近一次品鉴；
-- Postgres 的 make_interval 与 JS 的 addMonths 同样会把月末夹到目标月最后一天）。
--
-- 回填后存量条目的 nextRemindAt 都在**半年后**（默认间隔 6 个月）→ 跑批
-- 首日到期数为 0 是**正确行为**，不是没生效。验收要手工造一条到期数据。
UPDATE "cellar_items" ci
SET "nextRemindAt" =
  COALESCE(
    (SELECT max(t."createdAt")
       FROM cellar_tastings t
       JOIN cellar_items x ON x.id = t."cellarItemId"
      WHERE x."teaId" = ci."teaId" AND ci."teaId" IS NOT NULL),
    (SELECT max(t."createdAt") FROM cellar_tastings t WHERE t."cellarItemId" = ci.id),
    ci."acquiredAt",
    ci."createdAt"
  ) + make_interval(months => ci."remindEveryMonths")
WHERE ci."nextRemindAt" IS NULL AND ci."remindEveryMonths" > 0;
