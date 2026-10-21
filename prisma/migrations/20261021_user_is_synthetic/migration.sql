-- 自动化账号标记（PRD F0）：cron 任务只在标记账号内活动，不冒用真人。
-- 用法（本仓库迁移不走 prisma migrate deploy，全部手工 apply）：
--   docker compose -f /opt/puer-hub/docker-compose.yml exec -T postgres \
--     psql -U puerhub puerhub < 本文件
-- 可重复执行（IF NOT EXISTS）。
--
-- 部署顺序：先 apply 本 SQL 并执行标记，再起新镜像（同 reviewFeedback 迁移
-- 的铁律：新 Prisma client 会 select 这一列）。
-- 回滚：优先只回滚镜像、保留本列；若必须删列，先确认旧镜像运行正常再
--   ALTER TABLE "users" DROP COLUMN "isSynthetic";
-- （新镜像回滚后该列无人读取，保留无害。）
SET lock_timeout = '3s';
SET statement_timeout = '30s';

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "isSynthetic" BOOLEAN NOT NULL DEFAULT false;
