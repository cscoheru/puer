-- 0003_add_ai_original.sql
-- tea-draft 审校修改率基线：Article 加 aiOriginal 列，冻住 AI/拼装产出的原版。
-- 草稿创建时写入（verbatim 拼装），adapt 成功后更新为 adapt 输出；人工审校只改
-- content/summary，永不触碰此列 → diff(aiOriginal, 现值) 即纯人类修改量。
-- 纯加列（可空），向后兼容，可重复执行（IF NOT EXISTS）。
-- 也可由 `prisma db push` 自动生成等价变更；此文件用于生产手工 apply、可 review 可回溯。

ALTER TABLE articles ADD COLUMN IF NOT EXISTS "aiOriginal" JSONB; -- {title, content, summary}
