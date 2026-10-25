import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin-auth";
import { invalidateAuthCache } from "@/lib/auth";
import { MAX_RESET_REJECTS, RESET_STATUS } from "@/lib/password-reset";

export const dynamic = "force-dynamic";

/**
 * 这个哈希是不是 bcrypt —— `users.passwordHash` 只接受 bcrypt。
 *
 * 2026-10-24 的事故：旧版本（重置码那套）往申请单里存的是 **sha256**，
 * 批准时把它整个写进了 `users.passwordHash` → 站长的 uid 1001 当场
 * 登不进去（bcrypt.compare 拿 sha256 串当哈希比对，永远失败）。
 * 任何要写进用户表密码列的值，都得过这道检查。
 */
function isBcryptHash(hash: string): boolean {
  return /^\$2[aby]\$\d{2}\$/.test(hash);
}

/**
 * PUT /api/admin/password-resets/[id] —— 处理一条密码重置申请。
 *
 * ## 批准 = 「核对通过，启用用户自己定好的新密码」
 *
 * 站内没有邮件通道，密码**不能靠管理员转达**（站长原话：「如果用户不
 * 认识站长，站长如何将新密码告知用户？」）。所以新密码是**用户在申请时
 * 当场定好的**（只存哈希，管理员也看不到明文），管理员点「批准」只是
 * 确认「这个申请确实是本人提的」，然后把这个哈希写进用户表。
 *
 * 管理员从头到尾不碰别人的密码，也不需要给用户发任何「码」或「链接」。
 *
 * ## 拒绝 = 核对下来不是本人
 *
 * 连续两次被拒 → 账号挂起（不能再登录）。这是在挡「一直申请、一直骚扰」
 * 和「反复试探」。
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
  if (!request.passwordHash) {
    // 用户申请时没定新密码（老数据或管理员代发的申请）—— 没有可启用的密码。
    return NextResponse.json(
      { error: "这条申请没有用户自设的新密码，无法批准" },
      { status: 400 },
    );
  }
  if (!isBcryptHash(request.passwordHash)) {
    // ⚠️ 必须挡：users.passwordHash 只能是 bcrypt 哈希。
    // 旧版本（重置码那套）往申请单里存的是 sha256 —— 把它写进用户表，
    // 用户就再也登不进去了（bcrypt.compare 对着 sha256 串永远失败）。
    // 2026-10-24 站长 uid 1001 就是这样被锁在门外的。
    return NextResponse.json(
      {
        error:
          "这条申请是旧版本留下的（没有可用的新密码），请让用户重新提交一条申请。",
      },
      { status: 400 },
    );
  }

  // 批准 = 管理员核对通过 → 启用**用户申请时自设**的新密码。
  const now = new Date();

  await prisma.$transaction([
    prisma.user.update({
      where: { id: request.userId },
      data: { passwordHash: request.passwordHash, passwordChangedAt: now },
    }),
    prisma.passwordResetRequest.update({
      where: { id: request.id },
      data: {
        status: RESET_STATUS.approved,
        handledBy: session?.user?.name ?? session?.user?.email ?? null,
        handledAt: now,
      },
    }),
    prisma.notification.create({
      data: {
        userId: request.userId,
        type: "system",
        content:
          "你的密码重置申请已通过。现在可以用你申请时设置的新密码登录。" +
          "如果不是你本人操作，请立即联系站长。",
        link: null,
      },
    }),
  ]);

  // 立刻作废旧会话（否则 30 秒的 auth 缓存窗口内，旧 token 仍然有效）
  invalidateAuthCache(request.userId);

  return NextResponse.json({ success: true });
}
