-- 站点级运行时开关（2026-11-20）。
--
-- 需求：首页内联回复里的「AI 回复」要能由管理员在后台开关，而不是改 .env
-- 再重建镜像。这是第一项；后续运营开关沿用同一张表。
--
-- 只存开关与短文本，不存凭据。读取统一走 src/lib/site-settings.ts，
-- 那里的策略是「读不到 = 关闭」。
--
-- 幂等：可重复执行。
-- updatedAt 带 DB 默认值：本仓库的应急写库方式是裸 psql（见 release-checklist），
-- 少了默认值，`INSERT INTO site_settings(key,value) VALUES(...)` 会直接 NOT NULL 失败，
-- 而运维可能以为它成功了（R29 第 5 条）。
CREATE TABLE IF NOT EXISTS "site_settings" (
    "key"       VARCHAR(64) NOT NULL,
    "value"     VARCHAR(64) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,
    CONSTRAINT "site_settings_pkey" PRIMARY KEY ("key")
);
