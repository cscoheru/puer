import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  forgotPasswordSchema,
  generateTempPassword,
  MIN_PASSWORD_LENGTH,
  RESET_QUESTIONS,
  resetPasswordSchema,
  sessionInvalidated,
} from "./password-reset.ts";

// ─── 密码强度 ─────────────────────────────────────────────────────────────

test("新密码至少 6 位（与「创建用户」同一口径）", () => {
  assert.equal(
    resetPasswordSchema.safeParse({ password: "12345" }).success,
    false,
  );
  assert.equal(
    resetPasswordSchema.safeParse({ password: "123456" }).success,
    true,
  );
  assert.equal(
    resetPasswordSchema.safeParse({ password: "x".repeat(101) }).success,
    false,
  );
});

test("忘记密码申请必须填账号 + 两个核验答案", () => {
  const base = { account: "1001", registration: "2026年5月", lastLogin: "2026年10月" };
  assert.equal(forgotPasswordSchema.safeParse({ ...base, account: "" }).success, false);
  assert.equal(forgotPasswordSchema.safeParse(base).success, true);
  // 核验答案是这套流程的身份依据 —— 缺一题就不能成申请
  assert.equal(
    forgotPasswordSchema.safeParse({ account: "1001", registration: "2026年5月" })
      .success,
    false,
    "缺「最后登录时间」",
  );
  assert.equal(
    forgotPasswordSchema.safeParse({ account: "1001", lastLogin: "2026年10月" })
      .success,
    false,
    "缺「注册时间」",
  );
  assert.equal(
    forgotPasswordSchema.safeParse({ ...base, note: "x".repeat(201) }).success,
    false,
  );
});

test("核验题要能被用户答出来、也能被站点核对", () => {
  // 每一道题都必须有 label 与提示 —— 后台要拿它跟数据库对照，
  // 前台要让人知道该答什么。
  assert.ok(RESET_QUESTIONS.length >= 2);
  for (const q of RESET_QUESTIONS) {
    assert.ok(q.label.length > 0, `${q.key} 缺 label`);
    assert.ok(q.hint.length > 0, `${q.key} 缺提示`);
  }
  // 注册时间与最后登录时间 —— 用户点名要的两道
  const keys = RESET_QUESTIONS.map((q) => q.key);
  assert.ok(keys.includes("registration"));
  assert.ok(keys.includes("lastLogin"));
});

test("用户可以自设新密码（不认识站长也能自己定），也可以留空让管理员代设", () => {
  const base = { account: "1001", registration: "2026年5月", lastLogin: "2026年10月" };
  assert.equal(
    forgotPasswordSchema.safeParse({ ...base, newPassword: "abcdef" }).success,
    true,
  );
  assert.equal(
    forgotPasswordSchema.safeParse({ ...base, newPassword: "12345" }).success,
    false,
    "自设密码也要满足强度",
  );
  assert.equal(
    forgotPasswordSchema.safeParse(base).success,
    true,
    "留空 = 管理员代设",
  );
});

// ─── 临时密码 ─────────────────────────────────────────────────────────────

test("临时密码长度对、字符集不含易混的 0/O/1/l/I", () => {
  const p = generateTempPassword();
  assert.equal(p.length, 10);
  assert.match(p, /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]+$/);
  for (const ch of ["0", "O", "1", "l", "I"]) {
    assert.ok(!p.includes(ch), `临时密码不该出现易混字符 ${ch}`);
  }
});

test("临时密码每次都不一样（不是固定串）", () => {
  const set = new Set(Array.from({ length: 20 }, () => generateTempPassword()));
  assert.ok(set.size >= 19, `20 次生成应基本不重复，实际 ${set.size} 个不同值`);
});

// ─── 改密后旧会话失效 ─────────────────────────────────────────────────────

test("改密前签发的会话要作废，改密后的照常用", () => {
  const changedAt = new Date("2026-10-24T00:00:00.000Z");
  const before = Math.floor(new Date("2026-10-23T00:00:00.000Z").getTime() / 1000);
  const after = Math.floor(new Date("2026-10-25T00:00:00.000Z").getTime() / 1000);
  assert.equal(sessionInvalidated(changedAt, before), true, "旧密码的会话要作废");
  assert.equal(sessionInvalidated(changedAt, after), false, "新密码的会话照常用");
  assert.equal(sessionInvalidated(null, before), false, "没改过密码就不作废");
  assert.equal(sessionInvalidated(changedAt, undefined), false, "没有签发时刻就不判");
});

// ─── 防账号枚举（源码级断言）────────────────────────────────────────────────

/**
 * 找回密码是最经典的**账号枚举**入口：接口明说「该账号不存在」，攻击者
 * 就能拿一堆邮箱去试哪些注册过。所以成功与失败必须返回**完全一样**的话。
 *
 * 路由没法在 node:test 里跑（要 prisma），按仓库既有约定用源码断言钉住。
 */
const FORGOT_SRC = readFileSync(
  new URL("../app/api/auth/forgot-password/route.ts", import.meta.url),
  "utf8",
);

/** 去掉注释 —— 断言要看的是**代码**，不是解释这件事的注释。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("忘记密码接口不区分账号存不存在", () => {
  const code = stripComments(FORGOT_SRC);
  assert.ok(
    !/账号不存在|用户不存在|无此账号|未注册/.test(code),
    "接口不能说出「这个账号不存在」—— 那就是账号枚举",
  );
  // 成功路径只有一个，且不按是否找到用户分支
  const okReturns = code.match(/status: 200/g) ?? [];
  assert.equal(okReturns.length, 0, "不该有按账号存在与否分支的 200 返回");
});

test("忘记密码接口限速了（防刷申请、刷站内通知）", () => {
  const code = stripComments(FORGOT_SRC);
  assert.match(code, /LIMIT_FORGOT_PASSWORD/);
  assert.match(code, /checkRateLimit/);
});

test("自设的新密码只存哈希（明文不落库、管理员也看不到）", () => {
  const code = stripComments(FORGOT_SRC);
  assert.match(code, /bcrypt\.hash\(/, "自设密码必须先哈希");
  assert.match(code, /passwordHash/, "哈希存到申请单上");
  // 明文不能直接进数据库
  assert.ok(
    !/password:\s*parsed\.data\.newPassword/.test(code),
    "明文不能直接写进 passwordHash",
  );
});

/**
 * 管理员批准时：申请单带了用户自设的密码就直接用那个，没带才要管理员指定。
 */
const HANDLE_SRC = readFileSync(
  new URL(
    "../app/api/admin/password-resets/[id]/route.ts",
    import.meta.url,
  ),
  "utf8",
);

/**
 * 后台的申请列表必须**并排给出「用户填的」与「站点知道的」** ——
 * 站长据此客观判断是不是本人，而不是凭感觉批准。
 */
const LIST_SRC = readFileSync(
  new URL("../app/api/admin/password-resets/route.ts", import.meta.url),
  "utf8",
);

test("后台申请列表带上了站点知道的真值（供站长核对）", () => {
  const code = stripComments(LIST_SRC);
  for (const field of [
    "registeredAt",
    "lastLoginAt",
    "registrationIp",
    "registrationRegion",
    "requestIp",
  ]) {
    assert.match(code, new RegExp(field), `列表缺少 ${field}`);
  }
  // 用户填的答案也要带出来
  assert.match(code, /answers/);
});

test("批准申请时优先用用户自设的密码", () => {
  const code = stripComments(HANDLE_SRC);
  assert.match(code, /request\.passwordHash/, "先看申请单有没有自设密码");
  assert.match(code, /if\s*\(!passwordHash\)/, "没有才让管理员指定");
});
