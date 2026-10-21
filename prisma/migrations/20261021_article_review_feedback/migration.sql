-- 草稿「退回」反馈：人工审校对资讯草稿的选题质量判定。
-- 与 moderation（机器内容安全）语义分离，互不覆盖。
--
-- 用法（本仓库迁移不走 prisma migrate deploy，全部手工 apply）：
--   docker compose -f /opt/puer-hub/docker-compose.yml exec -T postgres \
--     psql -U puerhub puerhub < 本文件
-- 可重复执行（IF NOT EXISTS，对齐 0002_add_moderation_fields.sql 的规范）。
--
-- 部署顺序（重要）：**先 apply 本 SQL，再起新镜像**。
-- 新 Prisma client 会 select 这一列；若新镜像先上线而列不存在，全站文章
-- 查询会 P2022 ColumnNotFound（2026-09-01 同类事故，见 docs/release-checklist.md）。
-- 旧 client 不查这列，所以「旧代码 + 新列」完全兼容。
--
-- 回滚：优先只回滚镜像、保留本列（一个没人查的可空列对旧 client 无害）。
-- 若必须删列：先确认旧镜像运行正常，再执行
--   UPDATE articles SET status='draft' WHERE status='rejected';
--   ALTER TABLE "articles" DROP COLUMN "reviewFeedback";
-- （UPDATE 让已退回稿回到旧草稿箱可见，避免行变成不可见数据。）
SET lock_timeout = '3s';
SET statement_timeout = '30s';

ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "reviewFeedback" JSONB;
