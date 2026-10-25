-- F5 行情联动（PRD v0.3 §7 Phase 4）
--
-- 目标：给茶品页一条**手工整理**的价格区间时间线，并与站长线对照。
--
-- 关键约束：
--   1. **只录区间不录点值**（PRD F5 原文）。表里只有 low/high，没有「当前价」——
--      普洱的行情不是一个数，录点价等于编一个精确的数字。
--   2. **必须填来源与日期**（PRD F5 原文）。sourceLabel 是 NOT NULL。
--   3. 频率按季度 —— 但那是**约定**不是约束：站长有理由补录时应该能录，
--      所以只约束「同一款茶同一天不重复」（UNIQUE）。
--
-- 与 Tea.marketInfo 的关系：那份是东和抓来的单点字符串（PRD §11.2「不新增
-- 抓取，沿用现状」），本表是站长自己按季度整理的区间序列 —— 两者并存。
--
-- 部署顺序：**先执行本 SQL，再部署带新代码的镜像**（Prisma 生成的 Client
-- 需要这张表存在）。脚本幂等，重复执行安全。
--
-- 回滚：DROP TABLE price_snapshots;

-- 锁超时：CREATE TABLE / 加外键要拿锁。3 秒拿不到就失败退出，等一会儿重跑。
SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "price_snapshots" (
  "id" TEXT NOT NULL,
  "teaId" TEXT NOT NULL,
  "snapshotDate" DATE NOT NULL,
  "low" INTEGER NOT NULL,
  "high" INTEGER NOT NULL,
  "currency" VARCHAR(8) NOT NULL DEFAULT 'CNY',
  "sourceLabel" VARCHAR(60) NOT NULL,
  "note" VARCHAR(300),
  "enteredBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "price_snapshots_pkey" PRIMARY KEY ("id")
);

-- 同一款茶同一天只能有一条 —— 重录就是改，不是新增。
CREATE UNIQUE INDEX IF NOT EXISTS "price_snapshots_teaId_snapshotDate_key"
  ON "price_snapshots" ("teaId", "snapshotDate");

-- 茶品页按茶 + 时间倒序取序列。
CREATE INDEX IF NOT EXISTS "price_snapshots_teaId_snapshotDate_idx"
  ON "price_snapshots" ("teaId", "snapshotDate" DESC);

-- 外键（Postgres 不会自动给外键列建索引 —— 缺了它就是全表扫）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'price_snapshots_teaId_fkey'
  ) THEN
    ALTER TABLE "price_snapshots"
      ADD CONSTRAINT "price_snapshots_teaId_fkey"
      FOREIGN KEY ("teaId") REFERENCES "teas" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'price_snapshots_enteredBy_fkey'
  ) THEN
    ALTER TABLE "price_snapshots"
      ADD CONSTRAINT "price_snapshots_enteredBy_fkey"
      FOREIGN KEY ("enteredBy") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 区间必须是「低 ≤ 高」，且不是负数 —— CHECK 与应用层的 zod 一起挡。
-- 两层都挡住才算数：应用层会漂，约束不会。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'price_snapshots_range_check'
  ) THEN
    ALTER TABLE "price_snapshots"
      ADD CONSTRAINT "price_snapshots_range_check"
      CHECK ("low" >= 0 AND "high" >= "low");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'price_snapshots_source_check'
  ) THEN
    ALTER TABLE "price_snapshots"
      ADD CONSTRAINT "price_snapshots_source_check"
      CHECK (length(btrim("sourceLabel")) > 0);
  END IF;
END $$;
