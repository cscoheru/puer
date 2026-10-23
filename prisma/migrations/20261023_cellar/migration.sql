-- F2 我的茶仓（PRD v0.3 §5 Phase 2）
--
-- 目标：给用户一个「我自己的茶仓 + 我自己的品鉴线」，并在条目页对照站长线。
--
-- 关键约束（写进代码与文档，不只是注释）：
--   1. **用户的品鉴记录单独建表**（cellar_tastings），不与站长笔记
--      （tasting_notes）混在一起。tasting_notes 会被渲染成公开的「转化档案」
--      时间线，用户记录混进去就要在 8 个公开读取点逐个加过滤 —— 漏一个就是
--      隐私泄漏。物理隔离让这个风险归零。
--   2. **只增不删、全部可空**。迁移必须能在旧镜像还在跑的时候先执行。
--   3. **口径写进数据库**。储仓评分 45–60、四维 1–10、阶段/对照枚举都用
--      CHECK 约束钉死（Prisma schema 表达不了 CHECK，写在这里）。
--      应用层（zod）也会校验一层，两层都挡住才算数。
--
-- 部署顺序：先执行本 SQL，再部署带新代码的镜像（Prisma 生成的 Client
-- 需要这些表存在）。脚本幂等，重复执行安全。
--
-- 回滚：DROP TABLE cellar_tastings, storage_epochs, cellar_items,
--       tea_requests, descriptor_vocab CASCADE;
--       ALTER TABLE "users" DROP COLUMN "shareAggregate", "shareConsentedAt";

-- ─── 1. users：社区带同意开关（Phase 3 用，本次只建字段不做聚合）────────

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "shareAggregate" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "shareConsentedAt" TIMESTAMP(3);

-- ─── 2. cellar_items：茶仓条目 ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "cellar_items" (
  "id"                TEXT NOT NULL,
  "userId"            TEXT NOT NULL,
  "teaId"             TEXT,
  "teaRequestId"      TEXT,
  "name"              VARCHAR(200),
  "acquiredAt"        TIMESTAMP(3),
  "qtyNote"           VARCHAR(100),
  "remindEveryMonths" INTEGER NOT NULL DEFAULT 6,
  "nextRemindAt"      TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "cellar_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "cellar_items_userId_idx" ON "cellar_items" ("userId");
CREATE INDEX IF NOT EXISTS "cellar_items_teaId_idx"  ON "cellar_items" ("teaId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cellar_items_remindEveryMonths_check') THEN
    ALTER TABLE "cellar_items" ADD CONSTRAINT "cellar_items_remindEveryMonths_check"
      CHECK ("remindEveryMonths" BETWEEN 1 AND 60);
  END IF;
END $$;

-- ─── 3. storage_epochs：仓储期（换仓 = 新增一条，旧条保留）──────────────

CREATE TABLE IF NOT EXISTS "storage_epochs" (
  "id"                TEXT NOT NULL,
  "cellarItemId"      TEXT NOT NULL,
  "startsAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "storageScore"      INTEGER,
  "assessedBy"        VARCHAR(10) NOT NULL DEFAULT 'self',
  "city"              VARCHAR(50),
  "container"         VARCHAR(50),
  "legacyStorageLabel" VARCHAR(50),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "storage_epochs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "storage_epochs_cellarItemId_startsAt_idx"
  ON "storage_epochs" ("cellarItemId", "startsAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storage_epochs_storageScore_check') THEN
    -- 45 标准偏干 · 50 标准仓 · 55 标准偏湿 · 60 湿仓
    ALTER TABLE "storage_epochs" ADD CONSTRAINT "storage_epochs_storageScore_check"
      CHECK ("storageScore" IS NULL OR "storageScore" BETWEEN 45 AND 60);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storage_epochs_assessedBy_check') THEN
    ALTER TABLE "storage_epochs" ADD CONSTRAINT "storage_epochs_assessedBy_check"
      CHECK ("assessedBy" IN ('self', 'editor'));
  END IF;
END $$;

-- ─── 4. cellar_tastings：用户自己的品鉴记录 ─────────────────────────────

CREATE TABLE IF NOT EXISTS "cellar_tastings" (
  "id"             TEXT NOT NULL,
  "cellarItemId"   TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "tastedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stage"          VARCHAR(20),
  "deltaVsPrev"    VARCHAR(10),
  "dims"           JSONB,
  "descriptors"    JSONB,
  "grams"          DOUBLE PRECISION,
  "vessel"         VARCHAR(40),
  "note"           TEXT,
  "images"         JSONB,
  "visibility"     VARCHAR(20) NOT NULL DEFAULT 'private',
  "elapsedSeconds" INTEGER,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "cellar_tastings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "cellar_tastings_cellarItemId_tastedAt_idx"
  ON "cellar_tastings" ("cellarItemId", "tastedAt");
CREATE INDEX IF NOT EXISTS "cellar_tastings_userId_tastedAt_idx"
  ON "cellar_tastings" ("userId", "tastedAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cellar_tastings_stage_check') THEN
    -- 与 F1 的 STAGES 同一份词表（src/lib/tasting-extract/vocab.ts）
    ALTER TABLE "cellar_tastings" ADD CONSTRAINT "cellar_tastings_stage_check"
      CHECK ("stage" IS NULL OR "stage" IN ('ascending', 'peak', 'drinking', 'declining'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cellar_tastings_deltaVsPrev_check') THEN
    ALTER TABLE "cellar_tastings" ADD CONSTRAINT "cellar_tastings_deltaVsPrev_check"
      CHECK ("deltaVsPrev" IS NULL OR "deltaVsPrev" IN ('better', 'same', 'worse'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cellar_tastings_visibility_check') THEN
    ALTER TABLE "cellar_tastings" ADD CONSTRAINT "cellar_tastings_visibility_check"
      CHECK ("visibility" IN ('private', 'shared'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cellar_tastings_elapsedSeconds_check') THEN
    ALTER TABLE "cellar_tastings" ADD CONSTRAINT "cellar_tastings_elapsedSeconds_check"
      CHECK ("elapsedSeconds" IS NULL OR "elapsedSeconds" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cellar_tastings_dims_check') THEN
    -- 四维各 1–10 整数。jsonpath 只在「值是数字且越界」时命中，
    -- 非数字值不拦（那是应用层 zod 的事），避免误伤合法数据。
    ALTER TABLE "cellar_tastings" ADD CONSTRAINT "cellar_tastings_dims_check"
      CHECK ("dims" IS NULL OR (
        jsonb_typeof("dims") = 'object'
        AND NOT jsonb_path_exists(
          "dims",
          '$.keyvalue() ? (@.value.type() == "number" && (@.value < 1 || @.value > 10))'
        )
      ));
  END IF;
END $$;

-- ─── 5. tea_requests：自建茶品申请 ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tea_requests" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "name"          VARCHAR(200) NOT NULL,
  "brand"         VARCHAR(100),
  "year"          INTEGER,
  "type"          VARCHAR(10) NOT NULL DEFAULT 'raw',
  "weightSpec"    VARCHAR(50),
  "note"          TEXT,
  "status"        VARCHAR(20) NOT NULL DEFAULT 'pending',
  "mergedTeaId"   TEXT,
  "reviewedBy"    TEXT,
  "reviewedAt"    TIMESTAMP(3),
  "rejectReason"  VARCHAR(200),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "tea_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "tea_requests_status_createdAt_idx"
  ON "tea_requests" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "tea_requests_userId_idx" ON "tea_requests" ("userId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tea_requests_status_check') THEN
    ALTER TABLE "tea_requests" ADD CONSTRAINT "tea_requests_status_check"
      CHECK ("status" IN ('pending', 'approved', 'rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tea_requests_type_check') THEN
    ALTER TABLE "tea_requests" ADD CONSTRAINT "tea_requests_type_check"
      CHECK ("type" IN ('raw', 'ripe'));
  END IF;
END $$;

-- ─── 6. descriptor_vocab：描述词库（生熟 × 年份段 × 四维）──────────────

CREATE TABLE IF NOT EXISTS "descriptor_vocab" (
  "id"         TEXT NOT NULL,
  "tag"        VARCHAR(40) NOT NULL,
  "category"   VARCHAR(10) NOT NULL,
  "ageBracket" VARCHAR(20),
  "dim"        VARCHAR(20),
  "source"     VARCHAR(20) NOT NULL DEFAULT 'seed',
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "descriptor_vocab_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "descriptor_vocab_tag_category_key" UNIQUE ("tag", "category")
);

CREATE INDEX IF NOT EXISTS "descriptor_vocab_category_dim_idx"
  ON "descriptor_vocab" ("category", "dim");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'descriptor_vocab_category_check') THEN
    ALTER TABLE "descriptor_vocab" ADD CONSTRAINT "descriptor_vocab_category_check"
      CHECK ("category" IN ('raw', 'ripe', 'any'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'descriptor_vocab_dim_check') THEN
    ALTER TABLE "descriptor_vocab" ADD CONSTRAINT "descriptor_vocab_dim_check"
      CHECK ("dim" IS NULL OR "dim" IN ('aroma', 'flavor', 'waterPath', 'bodyFeel', 'any'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'descriptor_vocab_ageBracket_check') THEN
    ALTER TABLE "descriptor_vocab" ADD CONSTRAINT "descriptor_vocab_ageBracket_check"
      CHECK ("ageBracket" IS NULL OR "ageBracket" IN ('young', 'mid', 'aged', 'any'));
  END IF;
END $$;

-- ─── 7. 外键（单独一段，方便在已有数据上补挂）──────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cellar_items_userId_fkey') THEN
    ALTER TABLE "cellar_items" ADD CONSTRAINT "cellar_items_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cellar_items_teaId_fkey') THEN
    ALTER TABLE "cellar_items" ADD CONSTRAINT "cellar_items_teaId_fkey"
      FOREIGN KEY ("teaId") REFERENCES "teas"("id") ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cellar_items_teaRequestId_fkey') THEN
    ALTER TABLE "cellar_items" ADD CONSTRAINT "cellar_items_teaRequestId_fkey"
      FOREIGN KEY ("teaRequestId") REFERENCES "tea_requests"("id") ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storage_epochs_cellarItemId_fkey') THEN
    ALTER TABLE "storage_epochs" ADD CONSTRAINT "storage_epochs_cellarItemId_fkey"
      FOREIGN KEY ("cellarItemId") REFERENCES "cellar_items"("id") ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cellar_tastings_cellarItemId_fkey') THEN
    ALTER TABLE "cellar_tastings" ADD CONSTRAINT "cellar_tastings_cellarItemId_fkey"
      FOREIGN KEY ("cellarItemId") REFERENCES "cellar_items"("id") ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cellar_tastings_userId_fkey') THEN
    ALTER TABLE "cellar_tastings" ADD CONSTRAINT "cellar_tastings_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tea_requests_userId_fkey') THEN
    ALTER TABLE "tea_requests" ADD CONSTRAINT "tea_requests_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tea_requests_mergedTeaId_fkey') THEN
    ALTER TABLE "tea_requests" ADD CONSTRAINT "tea_requests_mergedTeaId_fkey"
      FOREIGN KEY ("mergedTeaId") REFERENCES "teas"("id") ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;
