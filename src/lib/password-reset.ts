/**
 * 密码找回：**核验题**、答案比对、以及重置码。
 *
 * ## 为什么是问答，不是邮箱
 *
 * 站内目前**没有真实邮箱** —— 注册时邮箱是自动生成的 `uidN@puer.local`，
 * 从 uid 就能猜出来，当密钥等于没有。所以「把重置链接发到邮箱」这条路
 * 现在走不通。**槽位留着**：将来支持真实邮箱注册了，同一个流程里加上
 * 邮箱校验即可（`forgotPasswordSchema` 已有 `email` 字段）。
 *
 * ## 每一道题要满足三条
 *
 *   1. **只有账号本人答得出来** —— 陌生人查不到
 *   2. **站点自己也有记录** —— 站长能客观核对，不用凭感觉
 *   3. **用户答得出来** —— 是他自己经历过的事，不是要他去翻记录
 *
 * 「注册时间」「最后登录时间」「注册省份」「发帖数」「评论数」「获赞数」
 * 正好都占：公开页面上查不到（只有账号主人自己知道大概），而数据库里
 * 有真值，站长一比就知道真假。
 *
 * ## 用户的回答不要求格式
 *
 * 「2026年5月」「2026-5」「大概26年」「记不清了」都接受 —— 解析不出来的
 * **不算错**，只标「无法核对」，由站长判断。系统给的是**参考**，不是判决。
 *
 * 查人的部分在 `src/lib/user-lookup.ts`（要连库，服务端专用）。
 */
import { z } from "zod";

import { passwordSchema } from "./password-policy.ts";

export { passwordSchema };

/** 密码最长几位（bcrypt 只取前 72 字节，但这里给个明确上限更好读）。 */
export const MAX_PASSWORD_LENGTH = 100;

// ─── 核验题 ─────────────────────────────────────────────────────────────

export const RESET_QUESTIONS = [
  { key: "registration", label: "你大概是哪年哪月注册的？" },
  { key: "lastLogin", label: "你最后一次登录大概是哪年哪月？" },
  { key: "region", label: "你注册时填的省份 / 地区是？" },
  { key: "articles", label: "你大概发过多少篇文章？" },
  { key: "comments", label: "你大概发过多少条评论？" },
  { key: "upvotes", label: "你大概收到过多少个赞？" },
] as const;

export type ResetQuestionKey = (typeof RESET_QUESTIONS)[number]["key"];

/** 「忘记密码」申请的入参。核验答案里的**时间两题必填** —— 它们是这套流程的身份依据。 */
export const forgotPasswordSchema = z.object({
  account: z.string().min(1, "请填写账号").max(100),
  registration: z.string().min(1, "请填写注册时间").max(60),
  lastLogin: z.string().min(1, "请填写最后登录时间").max(60),
  region: z.string().max(60).optional(),
  articles: z.string().max(60).optional(),
  comments: z.string().max(60).optional(),
  upvotes: z.string().max(60).optional(),
  /** 注册邮箱 —— 现在只是参考（注册邮箱是自动生成的），将来做真邮箱注册时它是校验项。 */
  email: z.string().max(200, "邮箱太长").optional(),
  note: z.string().max(200, "说明最多 200 字").optional(),
});

/** 「用重置码设置新密码」的入参。密码规则与注册同一份。 */
export const resetPasswordSchema = z.object({
  code: z.string().min(4, "请填写重置码").max(40),
  password: passwordSchema,
});

/** 申请单的状态。 */
export const RESET_STATUS = {
  /** 待管理员核对 */
  pending: "pending",
  /** 已批准 —— 用户可以凭重置码自己设新密码 */
  approved: "approved",
  /** 被驳回 */
  rejected: "rejected",
  /** 重置码已用过 */
  used: "used",
} as const;
export type ResetStatus = (typeof RESET_STATUS)[keyof typeof RESET_STATUS];

/** 连续被驳回几次就把账号挂起。 */
export const MAX_RESET_REJECTS = 2;

/**
 * 这个会话是不是在改密**之前**签发的 —— 是就该作废。
 *
 * JWT 是无状态的，服务端不存会话，所以只能拿「签发时刻」和「密码最后
 * 修改时刻」比：token 早于改密 → 那个会话属于旧密码 → 作废。
 * （NextAuth 刷新 token 时会保留原来的 iat，所以这个比较是有效的。）
 */
export function sessionInvalidated(
  passwordChangedAt: Date | null | undefined,
  iat: unknown,
): boolean {
  if (!passwordChangedAt) return false;
  if (typeof iat !== "number") return false;
  return iat * 1000 < passwordChangedAt.getTime();
}

// ─── 答案比对 ─────────────────────────────────────────────────────────────

/** 比对结论。`unknown` = 系统这边没有真值可比（不是用户的错）。 */
export type AnswerVerdict = "match" | "close" | "mismatch" | "unknown";

export interface VerificationFacts {
  registeredAt: string | null;
  lastLoginAt: string | null;
  region: string | null;
  articles: number;
  comments: number;
  upvotes: number;
}

export interface AnswerCheck {
  key: string;
  label: string;
  /** 用户填的原文 */
  claimed: string;
  /** 系统里的真值 */
  truth: string;
  verdict: AnswerVerdict;
  note: string;
}

/** 从自由回答里抠出年份与月份。「2026年5月」「2026-5」「2026」都认。 */
export function parseYearMonth(
  raw: string,
): { year: number; month: number | null } | null {
  const m = raw.match(/(\d{4})\s*[-年./]?\s*(\d{1,2})?/);
  if (!m) return null;
  const year = Number(m[1]);
  if (year < 1900 || year > 2100) return null;
  const month = m[2] === undefined ? null : Number(m[2]);
  if (month !== null && (month < 1 || month > 12)) return null;
  return { year, month };
}

/** 从自由回答里抠出一个数字（「大概 30 篇」→ 30）。 */
export function parseCount(raw: string): number | null {
  const m = raw.match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** 年月的吻合度。 */
function judgeYearMonth(
  claimed: { year: number; month: number | null },
  truthIso: string,
): { verdict: AnswerVerdict; note: string } {
  const t = new Date(truthIso);
  const ty = t.getUTCFullYear();
  const tm = t.getUTCMonth() + 1;
  if (claimed.year !== ty) {
    return { verdict: "mismatch", note: `年份对不上（系统是 ${ty} 年）` };
  }
  if (claimed.month === null) {
    return { verdict: "close", note: "年份对得上，月份没填" };
  }
  if (claimed.month === tm) {
    return { verdict: "match", note: "年月都对得上" };
  }
  return {
    verdict: "close",
    note: `年份对得上，月份差 ${Math.abs(claimed.month - tm)} 个月`,
  };
}

/** 数量的吻合度 —— 允许「大概」带来的误差。 */
function judgeCount(
  claimed: number,
  truth: number,
): { verdict: AnswerVerdict; note: string } {
  const diff = Math.abs(claimed - truth);
  if (diff <= Math.max(1, Math.trunc(truth * 0.15))) {
    return { verdict: "match", note: "基本吻合" };
  }
  if (diff <= Math.max(3, Math.trunc(truth * 0.5))) {
    return { verdict: "close", note: "有出入，但同一个量级" };
  }
  return { verdict: "mismatch", note: "差得远" };
}

/** 地区的吻合度（「广东」与「广东省」算对得上）。 */
function judgeRegion(
  claimed: string,
  truth: string | null,
): { verdict: AnswerVerdict; note: string } {
  if (!truth) {
    return { verdict: "unknown", note: "系统里没有注册地记录" };
  }
  const c = claimed.replace(/\s/g, "");
  const t = truth.replace(/\s/g, "");
  if (!c) return { verdict: "unknown", note: "没填" };
  if (c === t || c.includes(t) || t.includes(c)) {
    return { verdict: "match", note: "对得上" };
  }
  return { verdict: "mismatch", note: `对不上（系统是 ${truth}）` };
}

/** 把系统真值写成「2026年5月18日」。 */
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "无记录";
  const d = new Date(iso);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

/**
 * 逐题比对用户的回答与系统真值。
 *
 * 给站长的是**参考**，不是判决 —— 解析不出来的题标「无法核对」，
 * 由站长自己判断。格式不统一不算错（用户填什么格式无所谓）。
 */
export function compareAnswers(
  answers: Record<string, string | null | undefined>,
  facts: VerificationFacts,
): AnswerCheck[] {
  const out: AnswerCheck[] = [];
  const get = (k: string) => (answers[k] ?? "").trim();

  const push = (
    key: string,
    label: string,
    claimed: string,
    truth: string,
    verdict: AnswerVerdict,
    note: string,
  ) => out.push({ key, label, claimed: claimed || "（未填）", truth, verdict, note });

  // 注册时间
  {
    const claimed = get("registration");
    const parsed = parseYearMonth(claimed);
    if (!facts.registeredAt) {
      push("registration", "注册时间", claimed, "无记录", "unknown", "系统里没有记录");
    } else if (!parsed) {
      push("registration", "注册时间", claimed, fmtDay(facts.registeredAt), "unknown", "看不懂填的什么");
    } else {
      const j = judgeYearMonth(parsed, facts.registeredAt);
      push("registration", "注册时间", claimed, fmtDay(facts.registeredAt), j.verdict, j.note);
    }
  }

  // 最后登录时间
  {
    const claimed = get("lastLogin");
    const parsed = parseYearMonth(claimed);
    if (!facts.lastLoginAt) {
      push("lastLogin", "最后登录时间", claimed, "无记录", "unknown", "系统没记过（这题核不了）");
    } else if (!parsed) {
      push("lastLogin", "最后登录时间", claimed, fmtDay(facts.lastLoginAt), "unknown", "看不懂填的什么");
    } else {
      const j = judgeYearMonth(parsed, facts.lastLoginAt);
      push("lastLogin", "最后登录时间", claimed, fmtDay(facts.lastLoginAt), j.verdict, j.note);
    }
  }

  // 注册地
  {
    const claimed = get("region");
    const j = judgeRegion(claimed, facts.region);
    push("region", "注册地区", claimed, facts.region ?? "无记录", j.verdict, j.note);
  }

  // 三个数量
  for (const [key, label, truth] of [
    ["articles", "发过的文章", facts.articles],
    ["comments", "发过的评论", facts.comments],
    ["upvotes", "收到的赞", facts.upvotes],
  ] as const) {
    const claimed = get(key);
    const n = parseCount(claimed);
    if (n === null) {
      push(key, label, claimed, String(truth), "unknown", claimed ? "看不懂填的什么" : "没填");
    } else {
      const j = judgeCount(n, truth);
      push(key, label, claimed, String(truth), j.verdict, j.note);
    }
  }

  return out;
}

/** 汇总：几题吻合、几题接近、几题对不上。 */
export function summarizeChecks(checks: AnswerCheck[]): {
  match: number;
  close: number;
  mismatch: number;
  unknown: number;
  total: number;
} {
  const s = { match: 0, close: 0, mismatch: 0, unknown: 0, total: checks.length };
  for (const c of checks) s[c.verdict] += 1;
  return s;
}

// ─── 重置码 ───────────────────────────────────────────────────────────────

/** 随机临时密码（管理员直接替某人重置时用）。 */
export function generateTempPassword(length = 10): string {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  // 拒绝采样：≥ limit 的值会被 % 映射成偏低的下标，产生取模偏差。
  // ⚠️ 上界必须与随机数的取值范围一致 —— 用 Uint8 才是 0–255。
  const limit = 256 - (256 % alphabet.length);
  const out: string[] = [];
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const v of buf) {
      if (out.length >= length) break;
      if (v < limit) out.push(alphabet[v % alphabet.length]);
    }
  }
  return out.join("");
}

/** 重置码的字符集 —— 去掉容易看混的 0/O、1/l/I。 */
const RESET_CODE_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** 生成一个重置码（批准通过时给本人）。 */
export function generateResetCode(length = 12): string {
  const limit = 256 - (256 % RESET_CODE_ALPHABET.length);
  const out: string[] = [];
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const v of buf) {
      if (out.length >= length) break;
      if (v < limit) out.push(RESET_CODE_ALPHABET[v % RESET_CODE_ALPHABET.length]);
    }
  }
  return out.join("");
}

/**
 * 重置码的哈希。
 *
 * 用 sha256 而不是 bcrypt：重置码是**高熵随机串**（不是人选的密码），
 * 没有字典攻击面，快哈希正合适（bcrypt 反而会拖慢每次校验）。
 */
export async function hashResetCode(code: string): Promise<string> {
  const bytes = new TextEncoder().encode(code.trim().toUpperCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 校验一个重置码（比对哈希）。 */
export async function verifyResetCode(
  code: string,
  storedHash: string | null,
): Promise<boolean> {
  if (!storedHash) return false;
  return (await hashResetCode(code)) === storedHash;
}
