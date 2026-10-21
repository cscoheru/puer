-- F0 内容来源标注（PRD v0.3 §6 / F0）
--
-- 部署顺序铁律：先执行本 SQL，再部署带新字段的镜像（镜像读旧列不报错、
-- 新列缺失才报错）。
--
-- 只增不删，全部可空 / 带默认值，与现有行完全兼容：
--   origin              帖子来源；回填脚本跑完后全量非 human 值会被标注，
--                       human 帖也会显式写 'human'。回填窗口期允许 NULL。
--   "originNoteIds"     ai_from_notes 所依据的站长原始笔记 id 列表。
--   "postedAsAccountId" 统一署名账号 id。
--   "reviewedBy/At"     人审管理员与时间。
--
-- 回滚：ALTER TABLE articles DROP COLUMN origin, DROP COLUMN "originNoteIds",
--       DROP COLUMN "postedAsAccountId", DROP COLUMN "reviewedBy",
--       DROP COLUMN "reviewedAt", DROP COLUMN "sourceUrls";

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS origin VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "originNoteIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "postedAsAccountId" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sourceUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- 后续按 origin 过滤（前台标注、镜像闸、茶问检索）都走这个等值条件。
CREATE INDEX IF NOT EXISTS articles_origin_idx ON articles (origin);
