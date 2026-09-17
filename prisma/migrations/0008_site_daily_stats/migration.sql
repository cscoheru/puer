-- P1-fix: 每日站点流量快照表
-- 写入端: scripts/snapshot-views.sql (每天 05:00 cron 跑)
-- 读取端: src/app/(admin)/admin/page.tsx 第 118 行 $queryRaw
-- 7-day 趋势唯一数据源。viewCount 是累计值没有历史，必须靠 daily snapshot 算 delta。
CREATE TABLE IF NOT EXISTS "site_daily_stats" (
  "date" DATE NOT NULL,
  "totalViews" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "site_daily_stats_pkey" PRIMARY KEY ("date")
);

-- Backfill 一次：把今天的合计写入，admin 页面至少有 1 个点
INSERT INTO "site_daily_stats" ("date", "totalViews")
VALUES (CURRENT_DATE, COALESCE((SELECT SUM("viewCount") FROM articles), 0))
ON CONFLICT ("date") DO NOTHING;