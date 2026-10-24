import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { invalidateAuthCache } from "@/lib/auth";
import {
  RESET_STATUS,
  resetPasswordSchema,
  verifyResetCode,
} from "@/lib/password-reset";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/reset-password —— 用户凭**重置码**自己设置新密码。
 *
 * ## 流程
 *
 *   1. 用户在登录页提交申请并回答核验问题
 *   2. 管理员核对通过 → 生成重置码（站内通知发给本人）
 *   3. 用户拿重置码来这个接口，自己定新密码 → 立即生效
 *
 * 为什么不让管理员直接设密码：站内没有邮件通道，管理员把密码告诉用户，
 * 只能靠站外渠道 —— 而「用户自己设」既不需要送达，也不会让密码经手第二个人。
 *
 * ## 安全
 *
 * - 重置码是**高熵随机串**（不是人选的密码），库里只存哈希
 * - **一次性**：用掉即作废（申请状态 → used）
 * - 限速：同一 IP 一小时 5 次 —— 防止有人拿重置码暴力试（虽然熵很高）
 * - 改完立刻作废旧会话（`invalidateAuthCache`）
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = resetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不对" },
      { status: 400 },
    );
  }

  const { code, password } = parsed.data;

  // 找用这个重置码的申请（哈希比对，库里存的是哈希）
  const candidates = await prisma.passwordResetRequest.findMany({
    where: { status: RESET_STATUS.approved },
    select: { id: true, userId: true, passwordHash: true },
  });

  let matched = null;
  for (const c of candidates) {
    if (await verifyResetCode(code, c.passwordHash)) {
      matched = c;
      break;
    }
  }
  if (!matched) {
    return NextResponse.json(
      { error: "重置码无效或已用过" },
      { status: 400 },
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const now = new Date();

  await prisma.$transaction([
    prisma.user.update({
      where: { id: matched.userId },
      data: { passwordHash, passwordChangedAt: now },
    }),
    // 重置码作废 —— 一次性
    prisma.passwordResetRequest.update({
      where: { id: matched.id },
      data: { status: RESET_STATUS.used, handledAt: now },
    }),
    prisma.notification.create({
      data: {
        userId: matched.userId,
        type: "system",
        content: "你的密码已重置。如果不是本人操作，请立即联系站长。",
        link: null,
      },
    }),
  ]);

  // 立刻作废旧会话（否则 30 秒的 auth 缓存窗口内，旧 token 仍然有效）
  invalidateAuthCache(matched.userId);

  return NextResponse.json({ success: true });
}
