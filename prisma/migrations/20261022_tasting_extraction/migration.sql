-- F1 结构化抽取字段（PRD v0.3 §5 Phase 1）
--
-- 目标：让站长原始笔记产出可查询的时间线数据（stage / delta_vs_prev /
-- descriptors / grams / vessel），供 Phase 3 的站长线使用。
--
-- 关键约束（写进代码与文档，不只是注释）：
--   1. 原文不可变 —— 这些列只增不改 content。
--   2. 未提及保持 NULL —— 抽取器不得推测补全。
--   3. 四维分值（香气/滋味/水路/体感）不从旧笔记推测，故不建列；
--      旧笔记的量化时间线沿用已有五维（appearance/color/aroma/taste/aftertaste）。
--
-- 部署顺序：先执行本 SQL，再部署带新代码的镜像（Prisma 生成代码需要列存在）。
--
-- 回滚：ALTER TABLE "tasting_notes" DROP COLUMN ...;（会丢失抽取结果，原文不受影响）

ALTER TABLE "tasting_notes"
  ADD COLUMN IF NOT EXISTS "stage"          VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "deltaVsPrev"    VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "descriptors"    JSONB,
  ADD COLUMN IF NOT EXISTS "grams"          DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "vessel"         VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "extractionMeta" JSONB;

-- 站长线按茶品+时间取 stage 序列，这是最常用的查询形态。
CREATE INDEX IF NOT EXISTS "tasting_notes_tea_stage_idx"
  ON "tasting_notes" ("teaId", "stage")
  WHERE "stage" IS NOT NULL;
