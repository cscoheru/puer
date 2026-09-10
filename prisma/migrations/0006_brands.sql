-- 0006_brands.sql (P2-R14 品牌主数据)
-- 品牌实体表；茶品通过 teas.brand 字符串唯一关联（一茶一品牌）。
-- 种子：把现有 teas.brand 的去重值全部导入为品牌行。
CREATE TABLE IF NOT EXISTS "brands" (
  "id" TEXT NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "description" VARCHAR(500),
  "icon" VARCHAR(10),
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "brands_name_key" ON "brands"("name");

INSERT INTO "brands" ("id", "name")
SELECT 'brand_' || md5("brand"), "brand"
FROM (SELECT DISTINCT "brand" FROM "teas") t
ON CONFLICT ("name") DO NOTHING;
