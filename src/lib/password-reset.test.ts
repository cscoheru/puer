import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  forgotPasswordSchema,
  generateTempPassword,
  MIN_PASSWORD_LENGTH,
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

test("忘记密码申请必须填账号，说明可选", () => {
  assert.equal(forgotPasswordSchema.safeParse({ account: "" }).success, false);
  assert.equal(forgotPasswordSchema.safeParse({ account: "1001" }).success, true);
  assert.equal(
    forgotPasswordSchema.safeParse({ account: "1001", note: "x".repeat(201) })
      .success,
    false,
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
