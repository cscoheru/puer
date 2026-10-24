import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findUserByAccount } from "@/lib/user-lookup";
import { forgotPasswordSchema, RESET_STATUS } from "@/lib/password-reset";
import {
  checkRateLimit,
  getClientIP,
  rateLimitKey,
  LIMIT_FORGOT_PASSWORD,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/forgot-password —— 登录页的「忘记密码」。
 *
 * 站内**没有邮件通道**，所以没法把重置链接发给用户。这条接口做的是
 * 「记一笔申请 + 通知本人」：
 *
 *   1. 找到用户 → 建一条 pending 申请
 *   2. 给本人发一条站内通知（管理员在后台能看到这条申请）
 *   3. 管理员在后台重置密码
 *
 * ## 为什么不告诉调用方「这个账号不存在」
 *
 * 找回密码是最经典的**账号枚举**入口：接口明说「该账号不存在」，攻击者
 * 就能拿一堆邮箱去试哪些注册过。所以**成功与失败返回完全一样的话**，
 * 哪怕账号不存在也照发。
 *
 * 限速：一小时 3 次/IP —— 防止刷申请、刷站内通知。
 */
export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  const { allowed } = checkRateLimit(
    rateLimitKey(ip, "forgot-password"),
    LIMIT_FORGOT_PASSWORD,
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "请求过于频繁，请稍后再试" },
      { status: 429, headers: { "Retry-After": "3600" } },
    );
  }

  const body = await req.json().catch(() => ({}));
  const parsed = forgotPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "请填写账号" }, { status: 400 });
  }

  const user = await findUserByAccount(parsed.data.account);
  if (user) {
    // 同一用户同时只留一条 pending —— 重复申请没有意义，还会刷通知。
    const pending = await prisma.passwordResetRequest.findFirst({
      where: { userId: user.id, status: RESET_STATUS.pending },
      select: { id: true },
    });
    if (!pending) {
      await prisma.$transaction([
        prisma.passwordResetRequest.create({
          data: {
            userId: user.id,
            note: parsed.data.note?.trim() || null,
          },
        }),
        prisma.notification.create({
          data: {
            userId: user.id,
            type: "system",
            content:
              "我们收到了你的密码重置申请，站长会尽快处理。如果不是本人操作，请忽略这条。",
            link: null,
          },
        }),
      ]);
    }
  }

  // 统一话术：账号存在与否，返回一模一样。
  return NextResponse.json({
    ok: true,
    message:
      "已收到你的密码重置申请，站长会尽快处理。如果不是本人操作，请忽略这条。",
  });
}
