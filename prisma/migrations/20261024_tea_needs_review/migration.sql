-- 茶品库分层：经典 / 普通 / 待整理。
--
-- needsReview = true 是「待整理」层：**茶品素材**（从用户笔记导入后的提炼、
-- 用户自建、存量重复条目），只有站长与创建者本人看得见。编辑完（改名 /
-- 合并 / 提升为经典）就清成 false，进入公开的「普通」层。
-- 见 src/lib/tea-tier.ts。
--
-- 为什么不用枚举列：isClassic 已经是布尔位且全套功能都在用它，再加一个
-- 布尔位就够；枚举意味着所有读点都要改取值判断，而「经典」这一层的
-- 语义根本不会变。
--
-- 幂等（ADD COLUMN IF NOT EXISTS）+ 锁超时（同 20261023_cellar 迁移的做法）。
-- NOT NULL DEFAULT false 在 PG 11+ 是快操作，不重写表。
SET lock_timeout = '3s';

ALTER TABLE "teas" ADD COLUMN IF NOT EXISTS "needsReview" BOOLEAN NOT NULL DEFAULT false;

-- 后台审核队列与读点过滤都按 (needsReview, deletedAt) 查
CREATE INDEX IF NOT EXISTS "teas_needsReview_deletedAt_idx"
  ON "teas" ("needsReview", "deletedAt");
