-- 0005_brand_bars.sql (P2-R13 品牌吧配置入库)
-- 品牌吧从 classics 页硬编码常量迁入 DB，管理员可在 /admin/classics 编辑。
-- 未归入任何吧的品牌仍自动进「其他吧」（classics 页逻辑不变）。
CREATE TABLE IF NOT EXISTS "brand_bars" (
  "id" TEXT NOT NULL,
  "key" VARCHAR(50) NOT NULL,
  "label" VARCHAR(50) NOT NULL,
  "icon" VARCHAR(10),
  "brands" TEXT[],
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "brand_bars_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "brand_bars_key_key" ON "brand_bars"("key");

INSERT INTO "brand_bars" ("id", "key", "label", "icon", "brands", "sortOrder") VALUES
  ('bar_dayi',    'dayi',    '大益吧',   '🏷️', ARRAY['大益'],   1),
  ('bar_xiaguan', 'xiaguan', '下关吧',   '🏔️', ARRAY['下关'],   2),
  ('bar_fujin',   'fujin',   '福今吧',   '🍃', ARRAY['福今'],   3),
  ('bar_jindafu', 'jindafu', '今大福吧', '🧧', ARRAY['今大福'], 4),
  ('bar_liming',  'liming',  '黎明吧',   '🌅', ARRAY['黎明'],   5),
  ('bar_xinghai', 'xinghai', '兴海吧',   '🌊', ARRAY['兴海'],   6)
ON CONFLICT ("key") DO NOTHING;
