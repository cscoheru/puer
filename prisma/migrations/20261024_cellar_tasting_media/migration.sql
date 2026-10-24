-- 茶仓品鉴记录：按维度归类的描述词 + 视频。
--
-- 背景（2026-10-24 站长）：一条品鉴记录要能同时容纳「快速品鉴」与
-- 「详细记录」两种形态 ——
--   · dimTags：{aroma: [...], flavor: [...], waterPath: [...], bodyFeel: [...]}
--     每个维度各挂自己的关键词。descriptors 那个扁平数组继续留着（导出
--     格式依赖它），dimTags 额外保留「这个词属于哪一维」。
--   · videos：视频 URL 数组。与 images 同一套「站内上传地址」的约束。
--
-- 幂等（ADD COLUMN IF NOT EXISTS + CHECK 用 pg_constraint 包一层），
-- 重复执行安全。
--
-- 锁超时：ALTER TABLE 要拿 ACCESS EXCLUSIVE 锁。没有 lock_timeout 时，它会
-- 排在任何已持有该表锁的长事务后面 —— 而**后面每一个查 cellar_tastings 的
-- 查询**都排在 ALTER 后面。3 秒拿不到锁就失败退出，等一会儿重跑即可。
SET lock_timeout = '3s';

ALTER TABLE "cellar_tastings" ADD COLUMN IF NOT EXISTS "dimTags" JSONB;
ALTER TABLE "cellar_tastings" ADD COLUMN IF NOT EXISTS "videos" JSONB;

-- 24 小时间隔闸门每次都要「按 userId 找 createdAt 最新的一条」——
-- 没有这个索引就得全表扫。CREATE INDEX IF NOT EXISTS 是幂等的。
CREATE INDEX IF NOT EXISTS "cellar_tastings_userId_createdAt_idx"
  ON "cellar_tastings" ("userId", "createdAt");

-- CHECK 约束：ADD CONSTRAINT 没有 IF NOT EXISTS，要用 pg_constraint 包一层
-- （与 20261023_cellar 迁移同一套做法），否则重跑会报错中断。
--
-- 「两层都挡住才算数」：zod 挡形状与范围，这里再挡一道。应用层会漂移，
-- 约束不会 —— 将来有后台脚本绕过 zod 直接写库时，这一层还在。
--
-- ⚠️ dimTags 的**路径**规则（必须是站内 /uploads/ 地址）只在应用层 ——
-- DB 看到的是一串普通文本，判断「这是不是本站的地址」需要解析 URL。
-- DB 这一层挡的是**结构**：四个维度名、每维最多 20 个词、每词最多 40 字。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cellar_tastings_dimTags_check') THEN
    ALTER TABLE "cellar_tastings" ADD CONSTRAINT "cellar_tastings_dimTags_check"
      CHECK (
        "dimTags" IS NULL OR (
          jsonb_typeof("dimTags") = 'object'
          -- 只认四个维度：拼错的键（water_path）不能悄悄存进去
          AND NOT jsonb_path_exists(
            "dimTags",
            '$.keyvalue()?(@.key != "aroma" && @.key != "flavor" && @.key != "waterPath" && @.key != "bodyFeel")'
          )
          -- 每个维度值必须是数组，且不超过 20 个词
          AND NOT jsonb_path_exists(
            "dimTags",
            '$.keyvalue()?(@.value.type() != "array" || @.value.size() > 20)'
          )
          -- 词必须是字符串，且不超过 40 字
          AND NOT jsonb_path_exists(
            "dimTags",
            '$.keyvalue().value[*]?(@.type() != "string" || @.size() > 40)'
          )
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cellar_tastings_videos_check') THEN
    ALTER TABLE "cellar_tastings" ADD CONSTRAINT "cellar_tastings_videos_check"
      CHECK (
        "videos" IS NULL OR (
          jsonb_typeof("videos") = 'array'
          AND jsonb_array_length("videos") <= 3
          AND NOT jsonb_path_exists(
            "videos",
            '$[*]?(@.type() != "string" || @.size() > 500)'
          )
        )
      );
  END IF;
END $$;
