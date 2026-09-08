-- 0002_add_moderation_fields.sql
-- 内容审核机制:Article 加审核字段,Comment 加 status + moderation。
-- 纯加列(可空/有默认值),向后兼容,可重复执行(IF NOT EXISTS)。
-- 也可由 `prisma db push` 自动生成等价变更;此文件用于生产手工 apply、可 review 可回溯。

-- ── articles: 审核 ──
ALTER TABLE articles ADD COLUMN IF NOT EXISTS "moderation"  JSONB;        -- 审核结果 JSON
ALTER TABLE articles ADD COLUMN IF NOT EXISTS "moderatedBy" TEXT;          -- 审核管理员 id
ALTER TABLE articles ADD COLUMN IF NOT EXISTS "moderatedAt" TIMESTAMP(3); -- 人工审核时间
-- status 列已存在(draft|published|archived);pending_review 只是新增的取值,无需改列定义。

-- ── comments: 状态 + 审核 ──
ALTER TABLE comments ADD COLUMN IF NOT EXISTS "status"      TEXT NOT NULL DEFAULT 'published'; -- published | pending_review | rejected
ALTER TABLE comments ADD COLUMN IF NOT EXISTS "moderation"  JSONB;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS "moderatedBy" TEXT;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS "moderatedAt" TIMESTAMP(3);

-- ── 管理员审核队列按 status=pending_review 过滤,补索引(幂等)──
CREATE INDEX IF NOT EXISTS "articles_status_idx" ON "articles" ("status");
CREATE INDEX IF NOT EXISTS "comments_status_idx" ON "comments" ("status");
