-- 密码重置申请的「用户自设新密码」哈希。
--
-- 站内没有邮件通道，管理员没法把新密码告诉一个不认识自己的用户 ——
-- 所以让用户在申请时就把新密码定好，这里只存哈希（管理员也看不到明文），
-- 管理员点「批准」就把这个哈希写进 users.passwordHash。
--
-- 幂等 + 锁超时。
SET lock_timeout = '3s';

ALTER TABLE "password_reset_requests"
  ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;
