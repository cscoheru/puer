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

/** 「忘记密码」申请的入参。 */
export const forgotPasswordSchema = z.object({
  account: z.string().min(1, "请填写账号").max(100),
  note: z.string().max(200, "说明最多 200 字").optional(),
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
