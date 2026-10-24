/**
 * 密码重置的**纯逻辑**（不碰数据库，客户端也能 import）。
 *
 * 登录页的「忘记密码」与后台的「重置密码」共用这一份口径：
 * 密码最少几位、申请单长什么样、临时密码怎么生成。
 *
 * 查人的部分在 `src/lib/user-lookup.ts`（要连库，服务端专用）。
 */
import { z } from "zod";

/** 密码最少几位 —— 与「创建用户」同一口径。 */
export const MIN_PASSWORD_LENGTH = 6;

/** 密码最长几位（bcrypt 只取前 72 字节，但这里给个明确上限更好读）。 */
export const MAX_PASSWORD_LENGTH = 100;

/**
 * 密码找回的**核验题**。
 *
 * ## 为什么是问答，不是邮箱
 *
 * 站内目前**没有真实邮箱** —— 注册时邮箱是自动生成的 `uidN@puer.local`，
 * 从 uid 就能猜出来，当密钥等于没有。所以「把重置链接发到邮箱」这条路
 * 现在走不通。**槽位留着**：将来支持真实邮箱注册了，同一个流程里加上
 * 邮箱校验即可（`forgotPasswordSchema` 已经有 `email` 字段）。
 *
 * ## 每一道题要满足三条
 *
 *   1. **只有账号本人答得出来** —— 陌生人查不到
 *   2. **站点自己也有记录** —— 站长能客观核对，不用凭感觉
 *   3. **用户答得出来** —— 是他自己经历过的事，不是要他去翻记录
 *
 * 「注册时间」「最后登录时间」正好三条都占：公开页面上查不到（只有账号
 * 主人自己记得大概），而数据库里有精确值，站长一比就知道真假。
 * 「最早发过的那篇帖子标题」虽然公开，但要求精确标题 —— 作为第三道题
 * 增加核实成本，不作为唯一依据。
 */
export const RESET_QUESTIONS = [
  {
    key: "registration",
    label: "你大概是哪年哪月注册的？",
    hint: "记个大概就行，站长会跟记录核对",
    placeholder: "如 2026年5月",
  },
  {
    key: "lastLogin",
    label: "你最后一次登录大概是哪年哪月？",
    hint: "记个大概就行，站长会跟记录核对",
    placeholder: "如 2026年10月",
  },
] as const;

export type ResetQuestionKey = (typeof RESET_QUESTIONS)[number]["key"];

/**
 * 「忘记密码」申请的入参。
 *
 * `registration` / `lastLogin` 是**核验答案**（用户凭记忆填，站长拿
 * 数据库核对）—— 必填，因为它们就是这套流程的身份依据。
 *
 * `email` 目前只是**参考**（注册邮箱是自动生成的，证明不了什么）；
 * 将来支持真实邮箱注册后，它就是一道真正的校验题。
 *
 * `newPassword` 是**用户自设的新密码** —— 站内没有邮件通道，管理员没法把
 * 新密码告诉一个不认识自己的用户，所以让用户在申请时就把密码定好。
 * 服务端只存它的哈希（管理员也看不到明文），管理员点「批准」才生效。
 * 留空 = 由管理员代设（适合站长能联系上本人的场景）。
 */
export const forgotPasswordSchema = z.object({
  account: z.string().min(1, "请填写账号").max(100),
  registration: z.string().min(1, "请填写注册时间").max(40),
  lastLogin: z.string().min(1, "请填写最后登录时间").max(40),
  email: z.string().max(200, "邮箱太长").optional(),
  note: z.string().max(200, "说明最多 200 字").optional(),
  newPassword: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `密码至少 ${MIN_PASSWORD_LENGTH} 位`)
    .max(MAX_PASSWORD_LENGTH, "密码太长")
    .optional(),
});

/** 后台设置新密码的入参。 */
export const resetPasswordSchema = z.object({
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `密码至少 ${MIN_PASSWORD_LENGTH} 位`)
    .max(MAX_PASSWORD_LENGTH, "密码太长"),
});

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

/** 申请单的状态。 */
export const RESET_STATUS = {
  pending: "pending",
  done: "done",
  cancelled: "cancelled",
} as const;
export type ResetStatus = (typeof RESET_STATUS)[keyof typeof RESET_STATUS];

/**
 * 随机临时密码（后台点「随机生成」时用）。
 *
 * - 去掉容易看混的字符（0/O、1/l/I）—— 站长要把密码念给用户，念错就麻烦了
 * - 拒绝采样，避免 % 取模带来的偏置
 */
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
