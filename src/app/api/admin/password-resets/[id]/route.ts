import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin-auth";
import { invalidateAuthCache } from "@/lib/auth";
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
  // 拒绝：核对下来不是本人 → 把申请撤掉，别留在队列里刷屏。
  if (body.action === "reject") {
    const { error: rejectError } = await requirePermission("admin:users");
    if (rejectError) return rejectError;
    const { id: rejectId } = await params;
    const rejected = await prisma.passwordResetRequest.findUnique({
      where: { id: rejectId },
      select: { id: true, userId: true, status: true },
    });
    if (!rejected) {
      return NextResponse.json({ error: "申请不存在" }, { status: 404 });
    }
    if (rejected.status !== RESET_STATUS.pending) {
      return NextResponse.json(
        { error: "这条申请已经处理过了" },
        { status: 400 },
      );
    }
    await prisma.passwordResetRequest.update({
      where: { id: rejected.id },
      data: {
        status: RESET_STATUS.cancelled,
        handledBy: session?.user?.name ?? session?.user?.email ?? null,
        handledAt: new Date(),
      },
    });
    await prisma.notification.create({
      data: {
        userId: rejected.userId,
        type: "system",
        content:
          "我们没有通过你的密码重置申请。如果不是本人操作，请忽略这条。",
        link: null,
      },
    });
    return NextResponse.json({ success: true, rejected: true });
  }

  const request = await prisma.passwordResetRequest.findUnique({
    where: { id },
    select: { id: true, userId: true, status: true, passwordHash: true },
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

  // 用户在申请时**自设了**新密码 → 直接用他的（管理员看不到明文，也不用
  // 把它告诉用户 —— 用户自己知道）。没自设 → 管理员必须指定一个。
  let passwordHash = request.passwordHash;
  if (!passwordHash) {
    const parsed = resetPasswordSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "密码不合法" },
        { status: 400 },
      );
    }
    passwordHash = await bcrypt.hash(parsed.data.password, 12);
  }
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

  // 立刻作废旧会话（否则 30 秒的 auth 缓存窗口内，旧 token 仍然有效）
  invalidateAuthCache(request.userId);

  return NextResponse.json({ success: true });
}
