import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin-auth";
import { invalidateAuthCache } from "@/lib/auth";
import {
  generateResetCode,
  hashResetCode,
  MAX_RESET_REJECTS,
  RESET_STATUS,
} from "@/lib/password-reset";

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
        status: RESET_STATUS.rejected,
        handledBy: session?.user?.name ?? session?.user?.email ?? null,
        handledAt: new Date(),
      },
    });

    // 连续两次都没通过 → 账号挂起（不能再登录）。
    // 这是在挡「一直申请、一直骚扰」和「反复试探」—— 两次都不通过的人，
    // 要么是忘了自己账号，要么不是本人，两种都不该再让他试。
    const rejects = await prisma.passwordResetRequest.count({
      where: { userId: rejected.userId, status: RESET_STATUS.rejected },
    });
    let banned = false;
    if (rejects >= MAX_RESET_REJECTS) {
      await prisma.user.update({
        where: { id: rejected.userId },
        data: {
          banStatus: "banned",
          bannedAt: new Date(),
          banReason: `密码重置申请连续 ${rejects} 次未通过`,
        },
      });
      invalidateAuthCache(rejected.userId);
      banned = true;
    }

    await prisma.notification.create({
      data: {
        userId: rejected.userId,
        type: "system",
        content: banned
          ? "我们没有通过你的密码重置申请，且已多次未通过，账号已被暂停。如果不是本人操作，请联系站长。"
          : "我们没有通过你的密码重置申请。你可以再次申请。如果不是本人操作，请忽略这条。",
        link: null,
      },
    });
    return NextResponse.json({ success: true, rejected: true, banned });
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

  // 批准 = 管理员核对通过 → **生成一个重置码**给本人。
  // 密码由**用户自己**设（凭重置码），管理员从头到尾不碰别人的密码。
  const code = generateResetCode();
  const passwordHash = await hashResetCode(code);
  const now = new Date();

  await prisma.$transaction([
    prisma.user.update({
      where: { id: request.userId },
      data: { passwordHash, passwordChangedAt: now },
    }),
    prisma.passwordResetRequest.update({
      where: { id: request.id },
      data: {
        status: RESET_STATUS.approved,
        passwordHash,
        handledBy: session?.user?.name ?? session?.user?.email ?? null,
        handledAt: now,
      },
    }),
    prisma.notification.create({
      data: {
        userId: request.userId,
        type: "system",
        content: `你的密码重置申请已通过。重置码：${code}。到登录页的「忘记密码」里用它设置新密码。如果不是本人操作，请立即联系站长。`,
        link: null,
      },
    }),
  ]);

  // 立刻作废旧会话（否则 30 秒的 auth 缓存窗口内，旧 token 仍然有效）
  invalidateAuthCache(request.userId);

  // 重置码明文只在响应里给管理员一次（方便站外转达），站内通知里也有一份。
  return NextResponse.json({ success: true, code });
}
