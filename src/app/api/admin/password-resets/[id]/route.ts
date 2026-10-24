import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin-auth";
import { RESET_STATUS, resetPasswordSchema } from "@/lib/password-reset";

export const dynamic = "force-dynamic";

/**
 * PUT /api/admin/password-resets/[id] —— 处理一条密码重置申请。
 *
 * 做三件事（一个事务里）：
 *   1. 换掉密码哈希，并记下 `passwordChangedAt`
 *      （旧会话靠它作废 —— JWT 是无状态的，不记这个时间就换不掉旧会话）
 *   2. 申请标记为 done，记下是谁处理的
 *   3. 给用户发一条站内通知
 *
 * 新密码由**管理员设置**（或点「随机生成」）：站内没有邮件通道，
 * 没法把「重置链接」发给用户 —— 管理员把新密码通过站外渠道给用户。
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { session, error } = await requirePermission("admin:users");
  if (error) return error;
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const parsed = resetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "密码不合法" },
      { status: 400 },
    );
  }

  const request = await prisma.passwordResetRequest.findUnique({
    where: { id },
    select: { id: true, userId: true, status: true },
  });
  if (!request) {
    return NextResponse.json({ error: "申请不存在" }, { status: 404 });
  }
  if (request.status !== RESET_STATUS.pending) {
    return NextResponse.json(
      { error: "这条申请已经处理过了" },
      { status: 400 },
    );
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const now = new Date();

  await prisma.$transaction([
    prisma.user.update({
      where: { id: request.userId },
      data: { passwordHash, passwordChangedAt: now },
    }),
    prisma.passwordResetRequest.update({
      where: { id: request.id },
      data: {
        status: RESET_STATUS.done,
        handledBy: session?.user?.name ?? session?.user?.email ?? null,
        handledAt: now,
      },
    }),
    prisma.notification.create({
      data: {
        userId: request.userId,
        type: "system",
        content: "你的密码已被重置。如果不是本人操作，请立即联系站长。",
        link: null,
      },
    }),
  ]);

  return NextResponse.json({ success: true });
}
