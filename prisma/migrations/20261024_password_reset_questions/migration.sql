-- 密码找回的「问答式身份核验」：用户申请时回答几个只有本人知道、
-- 而站点也有记录的事实（注册时间、最后登录时间…），站长拿数据库对照。
--
--   users.lastLoginAt —— 之前根本没记「最后一次成功登录」，现在补上。
--     它既是核验题，也是「最近一次活动」的依据。
--   password_reset_requests.answers   —— 用户填的答案（JSON）。
--   password_reset_requests.requestIp —— 提交申请时的 IP，供站长与
--     账号的注册 IP 对照。
--
-- 幂等 + 锁超时。
SET lock_timeout = '3s';

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3);

ALTER TABLE "password_reset_requests"
  ADD COLUMN IF NOT EXISTS "answers" JSONB;

ALTER TABLE "password_reset_requests"
  ADD COLUMN IF NOT EXISTS "requestIp" VARCHAR(45);
