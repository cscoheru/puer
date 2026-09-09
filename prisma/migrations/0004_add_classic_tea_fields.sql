-- 0004_add_classic_tea_fields.sql (P2-R2 经典普洱模块)
-- teas: isClassic 策展标记 + marketInfo 东和行情快照
ALTER TABLE "teas" ADD COLUMN IF NOT EXISTS "isClassic" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "teas" ADD COLUMN IF NOT EXISTS "marketInfo" JSONB;
CREATE INDEX IF NOT EXISTS "teas_isClassic_idx" ON "teas" ("isClassic") WHERE "isClassic";
