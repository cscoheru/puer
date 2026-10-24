-- 密码重置：申请表 + 用户表上的「密码最后修改时刻」。
--
-- 背景：站内**没有邮件通道**，所以「把重置链接发给用户」做不到 ——
-- 用户在登录页提交申请，管理员在后台看到后重置密码。
--
-- passwordChangedAt 用来作废改密**之前**签发的会话：JWT 是无状态的，
-- 不记这个时间就换不掉旧会话（被顶下线的用户还能继续用旧 token 刷接口）。
--
-- 幂等 + 锁超时（与 20261023_cellar 同一套做法）。
SET lock_timeout = '3s';

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "password_reset_requests" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "status"    VARCHAR(20) NOT NULL DEFAULT 'pending',
  "note"      VARCHAR(200),
  "handledBy" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "handledAt" TIMESTAMP(3),
  CONSTRAINT "password_reset_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "password_reset_requests_status_createdAt_idx"
  ON "password_reset_requests" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "password_reset_requests_userId_status_idx"
  ON "password_reset_requests" ("userId", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'password_reset_requests_userId_fkey'
  ) THEN
    ALTER TABLE "password_reset_requests"
      ADD CONSTRAINT "password_reset_requests_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
