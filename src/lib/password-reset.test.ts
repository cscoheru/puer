import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  compareAnswers,
  forgotPasswordSchema,
  generateResetCode,
  generateTempPassword,
  hashResetCode,
  parseCount,
  parseYearMonth,
  RESET_QUESTIONS,
  resetPasswordSchema,
  sessionInvalidated,
  summarizeChecks,
  verifyResetCode,
} from "./password-reset.ts";

// ─── 核验题 ───────────────────────────────────────────────────────────────

test("核验题覆盖注册时间、最后登录、地区与三个数量", () => {
  const keys = RESET_QUESTIONS.map((q) => q.key);
  for (const k of [
    "registration",
    "lastLogin",
    "region",
    "articles",
    "comments",
    "upvotes",
  ]) {
    assert.ok(keys.includes(k as never), `少了「${k}」这一题`);
  }
  // 题目**不带提示**：用户填什么格式无所谓，站长判断是否接近
  for (const q of RESET_QUESTIONS) {
    assert.ok(q.label.length > 0, `${q.key} 缺 label`);
    assert.equal(
      (q as { hint?: string }).hint,
      undefined,
      `${q.key} 不该有提示 —— 格式不统一不是用户的错`,
    );
  }
});

test("忘记密码申请：账号与两个时间必填，其余选填", () => {
  const base = {
    account: "1001",
    registration: "2026年5月",
    lastLogin: "2026年10月",
  };
  assert.equal(forgotPasswordSchema.safeParse(base).success, true);
  assert.equal(
    forgotPasswordSchema.safeParse({ account: "1001", registration: "2026年5月" })
      .success,
    false,
  );
  assert.equal(
    forgotPasswordSchema.safeParse({ ...base, articles: "大概三十篇" }).success,
    true,
  );
});

// ─── 解析用户的自由回答 ───────────────────────────────────────────────────

test("年份月份解析：多种写法都认", () => {
  assert.deepEqual(parseYearMonth("2026年5月"), { year: 2026, month: 5 });
  assert.deepEqual(parseYearMonth("2026-5"), { year: 2026, month: 5 });
  assert.deepEqual(parseYearMonth("2026年"), { year: 2026, month: null });
  assert.deepEqual(parseYearMonth("2026"), { year: 2026, month: null });
  assert.equal(parseYearMonth("记不清了"), null);
  assert.equal(parseYearMonth("2019年201批次"), null, "月份不合法 → 认不出");
});

test("数量解析：从自由回答里抠数字", () => {
  assert.equal(parseCount("大概 30 篇"), 30);
  assert.equal(parseCount("三十多篇"), null, "中文数字认不出 → 交站长判断");
  assert.equal(parseCount("记不清"), null);
});

// ─── 逐题比对 ─────────────────────────────────────────────────────────────

/** 按题目的 key 取检查项 —— checks 的顺序是题目的顺序，不能靠下标。 */
function checkByKey(
  checks: ReturnType<typeof compareAnswers>,
  key: string,
) {
  const c = checks.find((x) => x.key === key);
  assert.ok(c, `没有「${key}」这一项`);
  return c!;
}

const FACTS = {
  registeredAt: "2026-05-18T00:00:00.000Z",
  lastLoginAt: "2026-10-20T00:00:00.000Z",
  region: "广东省",
  articles: 27,
  comments: 12,
  upvotes: 40,
};

test("注册时间：年月都对得上 → 吻合", () => {
  const [c] = compareAnswers({ registration: "2026年5月" }, FACTS);
  assert.equal(c.verdict, "match");
});

test("注册时间：年份对、月份差 → 接近（不是不符）", () => {
  const [c] = compareAnswers({ registration: "2026年8月" }, FACTS);
  assert.equal(c.verdict, "close");
  assert.match(c.note, /月份差/);
});

test("注册时间：只填了年份 → 接近（月份没填不算错）", () => {
  const [c] = compareAnswers({ registration: "2026年" }, FACTS);
  assert.equal(c.verdict, "close");
});

test("注册时间：年份就不对 → 不符", () => {
  const [c] = compareAnswers({ registration: "2024年5月" }, FACTS);
  assert.equal(c.verdict, "mismatch");
});

test("最后登录：系统没记过 → 无法核对（不是用户的错）", () => {
  const c = checkByKey(
    compareAnswers({ lastLogin: "2026年10月" }, { ...FACTS, lastLoginAt: null }),
    "lastLogin",
  );
  assert.equal(c.verdict, "unknown");
  assert.match(c.note, /没记过/);
});

test("注册地区：广东 / 广东省 都算对得上", () => {
  const jd = (v: string) =>
    checkByKey(compareAnswers({ region: v }, FACTS), "region").verdict;
  assert.equal(jd("广东省"), "match");
  assert.equal(jd("广东"), "match");
  assert.equal(jd("北京"), "mismatch");
});

test("数量：接近就算接近，远了就对不上", () => {
  const near = checkByKey(
    compareAnswers({ articles: "30篇" }, FACTS),
    "articles",
  ).verdict;
  const far = checkByKey(
    compareAnswers({ articles: "300篇" }, FACTS),
    "articles",
  ).verdict;
  assert.ok(["match", "close"].includes(near), "27 vs 30 应算接近");
  assert.equal(far, "mismatch");
});

test("数量：看不懂就标无法核对，不算错", () => {
  const c = checkByKey(compareAnswers({ articles: "记不清" }, FACTS), "articles");
  assert.equal(c.verdict, "unknown");
});

test("汇总：几题吻合几题对不上", () => {
  const checks = compareAnswers(
    { registration: "2026年5月", lastLogin: "2026年10月", region: "广东" },
    FACTS,
  );
  const s = summarizeChecks(checks);
  assert.equal(s.total, RESET_QUESTIONS.length);
  assert.equal(s.match, 3);
  assert.equal(s.mismatch, 0);
});

// ─── 重置码与临时密码 ─────────────────────────────────────────────────────

test("重置码够长、字符集不含易混的 0/O/1/l/I", () => {
  const code = generateResetCode();
  assert.equal(code.length, 12);
  for (const ch of ["0", "O", "1", "l", "I"]) {
    assert.ok(!code.includes(ch), `重置码不该出现易混字符 ${ch}`);
  }
});

test("重置码的哈希可校验，且大小写/空格不敏感", async () => {
  const code = generateResetCode();
  const hash = await hashResetCode(code);
  assert.equal(await verifyResetCode(code, hash), true);
  assert.equal(await verifyResetCode(` ${code.toLowerCase()} `, hash), true);
  assert.equal(await verifyResetCode(code + "x", hash), false);
  assert.equal(await verifyResetCode(code, null), false);
});

test("临时密码长度对、字符集不含易混的 0/O/1/l/I", () => {
  const p = generateTempPassword();
  assert.equal(p.length, 10);
  for (const ch of ["0", "O", "1", "l", "I"]) {
    assert.ok(!p.includes(ch), `临时密码不该出现易混字符 ${ch}`);
  }
});

// ─── 改密后旧会话要作废 ───────────────────────────────────────────────────

test("改密前签发的会话要作废，改密后的照常用", () => {
  const changedAt = new Date("2026-10-24T00:00:00.000Z");
  const before = Math.floor(
    new Date("2026-10-23T00:00:00.000Z").getTime() / 1000,
  );
  const after = Math.floor(
    new Date("2026-10-25T00:00:00.000Z").getTime() / 1000,
  );
  assert.equal(sessionInvalidated(changedAt, before), true, "旧密码的会话要作废");
  assert.equal(sessionInvalidated(changedAt, after), false, "新密码的会话照常用");
  assert.equal(sessionInvalidated(null, before), false, "没改过密码就不作废");
  assert.equal(
    sessionInvalidated(changedAt, undefined),
    false,
    "没有签发时刻就不判",
  );
});

// ─── 密码规则：自助重置与注册同一份 ───────────────────────────────────────

test("用重置码设新密码：密码规则与注册一致（≥8 位、含字母、含数字）", () => {
  assert.equal(
    resetPasswordSchema.safeParse({ code: "ABCD1234", password: "abcdefgh" })
      .success,
    false,
    "没有数字",
  );
  assert.equal(
    resetPasswordSchema.safeParse({ code: "ABCD1234", password: "abcdef1" })
      .success,
    false,
    "不足 8 位",
  );
  assert.equal(
    resetPasswordSchema.safeParse({ code: "ABCD1234", password: "abcdefg1" })
      .success,
    true,
    "8 位 + 字母 + 数字",
  );
});

// ─── 源码级断言（路由没法在 node:test 里跑）───────────────────────────────

/** 去掉注释 —— 断言要看的是**代码**，不是解释这件事的注释。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const FORGOT_SRC = readFileSync(
  new URL("../app/api/auth/forgot-password/route.ts", import.meta.url),
  "utf8",
);

test("忘记密码接口不区分账号存不存在", () => {
  const code = stripComments(FORGOT_SRC);
  assert.ok(
    !/账号不存在|用户不存在|无此账号|未注册/.test(code),
    "接口不能说出「这个账号不存在」—— 那就是账号枚举",
  );
  const okReturns = code.match(/status: 200/g) ?? [];
  assert.equal(okReturns.length, 0, "不该有按账号存在与否分支的 200 返回");
});

test("忘记密码接口限速了（防刷申请、刷站内通知）", () => {
  const code = stripComments(FORGOT_SRC);
  assert.match(code, /LIMIT_FORGOT_PASSWORD/);
  assert.match(code, /checkRateLimit/);
});

test("申请单上**不存密码**（密码由本人通过重置码自己设）", () => {
  const code = stripComments(FORGOT_SRC);
  assert.ok(
    !/passwordHash/.test(code),
    "申请阶段不该写密码 —— 站点还没核对过身份",
  );
});

/**
 * 批准 → 生成重置码；驳回 → 计数；连续两次驳回 → 挂起账号。
 */
const HANDLE_SRC = readFileSync(
  new URL(
    "../app/api/admin/password-resets/[id]/route.ts",
    import.meta.url,
  ),
  "utf8",
);

test("批准申请时生成一次性重置码（管理员不碰别人的密码）", () => {
  const code = stripComments(HANDLE_SRC);
  assert.match(code, /generateResetCode/);
  assert.match(code, /hashResetCode/);
  assert.ok(
    !/bcrypt\.hash/.test(code),
    "管理员这一侧不该出现密码哈希 —— 密码由本人设",
  );
});

test("连续驳回两次 → 账号挂起", () => {
  const code = stripComments(HANDLE_SRC);
  assert.match(code, /MAX_RESET_REJECTS/);
  assert.match(code, /banStatus:\s*"banned"/);
});

/**
 * 用户凭重置码自己设新密码 —— 重置码一次性。
 */
const RESET_PW_SRC = readFileSync(
  new URL("../app/api/auth/reset-password/route.ts", import.meta.url),
  "utf8",
);

test("重置码只能用一次（用掉即作废）", () => {
  const code = stripComments(RESET_PW_SRC);
  assert.match(code, /verifyResetCode/);
  assert.match(code, /status:\s*RESET_STATUS\.used/);
});

test("改完密码立刻作废旧会话", () => {
  const code = stripComments(RESET_PW_SRC);
  assert.match(code, /invalidateAuthCache/);
});
