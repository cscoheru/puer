-- 真实读者视图表（PRD v0.3 §12 真实读者基线）
--
-- 背景：/api/views 一直在往这张表写，但**表从未被创建** —— 裸 SQL 引用了
-- 一张不存在的表，异常被 catch 吞掉且仍返回 200，功能全程静默失效，
-- 无人发现。现在它进了 Prisma schema，迁移是唯一的建表途径。
--
-- 与 Article.viewCount 的分工（两条轨）：
--   Article.viewCount — SSR 每渲染一次 +1，含爬虫/刷新/站长自己，用于热度排序
--   article_views     — 客户端 beacon 触发，按 (article, visitor, day) 去重，
--                       剔除爬虫 UA 与管理员/作者本人，用于真实读者数与来源渠道
--
-- 部署顺序铁律：先执行本 SQL，再部署带新代码的镜像。
--
-- 回滚：DROP TABLE article_views;（历史数据丢失，但 viewCount 轨不受影响）

CREATE TABLE IF NOT EXISTS "article_views" (
  "id"          TEXT NOT NULL,
  "articleId"   TEXT NOT NULL,
  "visitorKey"  VARCHAR(64) NOT NULL,
  "day"         DATE NOT NULL,
  "refererHost" VARCHAR(120),
  "referer"     VARCHAR(500),
  "landingPath" VARCHAR(300),
  "userAgent"   VARCHAR(300),
  "isLoggedIn"  BOOLEAN NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "article_views_pkey" PRIMARY KEY ("id"),
  -- 幂等：同一文章、同一访客、同一天只记一次
  CONSTRAINT "article_views_article_visitor_day_key" UNIQUE ("articleId", "visitorKey", "day")
);

CREATE INDEX IF NOT EXISTS "article_views_day_idx" ON "article_views" ("day");
CREATE INDEX IF NOT EXISTS "article_views_referer_day_idx" ON "article_views" ("refererHost", "day");

-- 外键：文章被删时连带清掉视图记录
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'article_views_articleId_fkey'
  ) THEN
    ALTER TABLE "article_views"
      ADD CONSTRAINT "article_views_articleId_fkey"
      FOREIGN KEY ("articleId") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
