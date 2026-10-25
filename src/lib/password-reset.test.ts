import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  answersMatchIdentity,
  canonicalAnswer,
  compareAnswers,
  forgotPasswordSchema,
  isAdminBackedRequest,
  parseCount,
  parseYearMonth,
  RESET_IDENTITY_KEYS,
  RESET_QUESTIONS,
  resetStatusSchema,
  sessionInvalidated,
  summarizeChecks,
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

test("忘记密码申请：账号 + 新密码必填，两个时间题由服务端在提交申请时把关", () => {
  const base = {
    account: "1001",
    registration: "2026年5月",
    lastLogin: "2026年10月",
    password: "abcd1234",
  };
  assert.equal(forgotPasswordSchema.safeParse(base).success, true);
  assert.equal(
    forgotPasswordSchema.safeParse({ ...base, password: undefined }).success,
    false,
    "新密码必须定",
  );
  assert.equal(
    forgotPasswordSchema.safeParse({ ...base, account: "" }).success,
    false,
    "账号必填",
  );
  assert.equal(
    forgotPasswordSchema.safeParse({ ...base, articles: "大概三十篇" }).success,
    true,
  );
  // 管理员作保的那条路不需要回答问题 —— 所以 schema 里时间题是选填
  assert.equal(
    forgotPasswordSchema.safeParse({ account: "1001", password: "abcd1234" })
      .success,
    true,
  );
});

test("查申请状态：只要账号", () => {
  assert.equal(resetStatusSchema.safeParse({ account: "1001" }).success, true);
  assert.equal(resetStatusSchema.safeParse({ account: "" }).success, false);
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

// ─── 身份钥匙（替代原来的「重置码」）────────────────────────────────────

test("归一后，「2026年5月」「2026-05」「2026.5」是同一件事", () => {
  assert.equal(canonicalAnswer("registration", "2026年5月"), "2026-5");
  assert.equal(canonicalAnswer("registration", "2026-05"), "2026-5");
  assert.equal(canonicalAnswer("registration", "2026.5"), "2026-5");
  assert.equal(canonicalAnswer("registration", "2026年"), "2026");
  assert.equal(canonicalAnswer("articles", "大概30篇"), "30");
  assert.equal(canonicalAnswer("articles", "30"), "30");
  // 中文数字抠不出数字 → 按原文比（两次写一样才算通过）
  assert.equal(canonicalAnswer("articles", "大概三十篇"), "大概三十篇");
  assert.equal(canonicalAnswer("region", " 广东 "), "广东");
});

test("空答案归一成 null（缺一题就不放行）", () => {
  assert.equal(canonicalAnswer("registration", ""), null);
  assert.equal(canonicalAnswer("registration", "   "), null);
  assert.equal(canonicalAnswer("registration", undefined), null);
});

test("身份钥匙：两题都对得上才放行", () => {
  assert.deepEqual(
    [...RESET_IDENTITY_KEYS],
    ["registration", "lastLogin"],
    "身份钥匙就是那两个时间题",
  );
  const stored = { registration: "2026年5月", lastLogin: "2026年10月" };
  assert.equal(
    answersMatchIdentity(stored, { registration: "2026-05", lastLogin: "2026.10" }),
    true,
    "写法不同但内容一样 → 放行",
  );
  assert.equal(
    answersMatchIdentity(stored, { registration: "2026年5月", lastLogin: "2026年9月" }),
    false,
    "月份对不上 → 不放行",
  );
  assert.equal(
    answersMatchIdentity(stored, { registration: "2026年5月" }),
    false,
    "少答一题 → 不放行",
  );
  assert.equal(
    answersMatchIdentity(stored, { registration: "2026年5月", lastLogin: "" }),
    false,
    "空答案 → 不放行",
  );
  assert.equal(
    answersMatchIdentity(
      { registration: "记不清了", lastLogin: "记不清了" },
      { registration: "记不清了", lastLogin: "记不清了" },
    ),
    true,
    "两次都写「记不清了」→ 原文一致，放行（站长那关才是真门槛）",
  );
});

test("管理员作保的申请没有答案可比 → 不需要用户回答问题", () => {
  assert.equal(isAdminBackedRequest(null), true);
  assert.equal(isAdminBackedRequest({}), true);
  assert.equal(
    isAdminBackedRequest({ region: "广东", articles: "10" }),
    true,
    "没有两个时间题 = 管理员发起的",
  );
  assert.equal(
    isAdminBackedRequest({ registration: "2026年5月", lastLogin: "2026年10月" }),
    false,
    "有用户自己填的时间题 = 用户发起的，要重答",
  );
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

test("设新密码：密码规则与注册一致（≥8 位、含字母、含数字）", () => {
  const base = {
    account: "1001",
    registration: "2026年5月",
    lastLogin: "2026年10月",
  };
  assert.equal(
    forgotPasswordSchema.safeParse({ ...base, password: "abcdefgh" }).success,
    false,
    "没有数字",
  );
  assert.equal(
    forgotPasswordSchema.safeParse({ ...base, password: "abcdef1" }).success,
    false,
    "不足 8 位",
  );
  assert.equal(
    forgotPasswordSchema.safeParse({ ...base, password: "abcdefg1" }).success,
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

test("申请单上只存密码的**哈希**，明文不进库", () => {
  const code = stripComments(FORGOT_SRC);
  assert.match(
    code,
    /bcrypt\.hash\(password/,
    "申请时要先把用户自设的密码哈希再存",
  );
  assert.ok(
    !/passwordHash:\s*password\b/.test(code),
    "存进申请单的必须是哈希，不能是明文",
  );
});

/**
 * 批准 → 启用用户申请时自设的密码；驳回 → 计数；连续两次驳回 → 挂起账号。
 */
const HANDLE_SRC = readFileSync(
  new URL(
    "../app/api/admin/password-resets/[id]/route.ts",
    import.meta.url,
  ),
  "utf8",
);

test("批准 = 启用用户自设的密码（管理员不碰别人的密码，也没有重置码）", () => {
  const code = stripComments(HANDLE_SRC);
  assert.match(
    code,
    /passwordHash:\s*request\.passwordHash/,
    "批准时把申请单里那个哈希写进用户表",
  );
  assert.ok(
    !/bcrypt\.hash/.test(code),
    "管理员这一侧不该自己算密码 —— 密码是用户自己设的",
  );
  assert.ok(
    !/generateResetCode|hashResetCode|resetCode/.test(code),
    "不该再有「重置码」这套东西 —— 站内没有邮件通道，码只会卡在通知列表里",
  );
});

test("写进用户表的密码哈希必须是 bcrypt（旧版的 sha256 会把人锁在门外）", () => {
  const code = stripComments(HANDLE_SRC);
  assert.match(code, /isBcryptHash/, "批准前要验一下哈希类型");
  assert.match(code, /\$2\[aby\]/, "只认 bcrypt");
});

test("连续驳回两次 → 账号挂起", () => {
  const code = stripComments(HANDLE_SRC);
  assert.match(code, /MAX_RESET_REJECTS/);
  assert.match(code, /banStatus:\s*"banned"/);
});

test("重置后申请单作废（used），改完密码立刻作废旧会话", () => {
  const code = stripComments(FORGOT_SRC);
  assert.match(code, /status:\s*RESET_STATUS\.used/);
  assert.match(code, /invalidateAuthCache/);
});

test("后台看得到注册 IP 反查出来的省份", () => {
  const src = readFileSync(
    new URL("../app/api/admin/password-resets/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /resolveIpRegion/);
  assert.match(src, /registrationIp/);
  assert.match(src, /requestIp/);
});

test("状态查询限速了（防枚举账号）", () => {
  const code = stripComments(FORGOT_SRC);
  assert.match(code, /LIMIT_RESET_STATUS/);
});
