import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { requirePermission } from "@/lib/admin-auth";
import { invalidateAuthCache } from "@/lib/auth";
import { RESET_STATUS } from "@/lib/password-reset";

export const dynamic = "force-dynamic";

/**
 * PUT /api/admin/users/[id]/password —— 直接给某个用户发起密码重置。
 *
 * 不需要用户先提交申请 —— 管理员在用户管理里看到某个用户联系不上，
 * 直接就能发起（这是「帮助用户进行密码重置」最直接的形态）。
 *
 * ## 管理员**不碰别人的密码**
 *
 * 站内没有邮件通道，管理员把密码告诉用户只能靠站外渠道 —— 用户不认识
 * 站长的话，这条路走不通。所以管理员的动作是「**作保**：给这个账号开一条
 * 已批准的重置」，用户到登录页点「忘记密码」、填上账号，**自己**设新密码。
 *
 * 这条申请**没有核验答案**（`answers` 为空），所以用户不需要回答任何
 * 问题 —— 身份由管理员担保。
 *
 * 另外给本人发一条站内通知 —— 密码即将由本人重置，本人必须知道。
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { error } = await requirePermission("admin:users");
  if (error) return error;
  const { id } = await params;

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, username: true, isSynthetic: true },
  });
  if (!user) {
    return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  }

  const now = new Date();

  // 申请单上记一条 —— 站长日后能查到「给谁发起重置」。
  // 同一用户只留一条「已批准」的重置，多了会让用户不知道该用哪条。
  await prisma.passwordResetRequest.updateMany({
    where: { userId: user.id, status: RESET_STATUS.approved },
    data: { status: RESET_STATUS.superseded, handledAt: now },
  });

  const ops: Prisma.PrismaPromise<unknown>[] = [
    prisma.passwordResetRequest.create({
      data: {
        userId: user.id,
        status: RESET_STATUS.approved,
        note: "管理员直接发起",
        answers: {},
        handledBy: "admin",
        handledAt: now,
        requestIp: null,
      },
    }),
  ];
  // 自动化账号是机器，发通知没有意义（它们也不会看站内信）。
  if (!user.isSynthetic) {
    ops.push(
      prisma.notification.create({
        data: {
          userId: user.id,
          type: "system",
          content:
            "管理员为你发起了一次密码重置。到登录页点「忘记密码」，填上账号，" +
            "就能自己设置新密码。如果不是本人操作，请立即联系站长。",
          link: null,
        },
      }),
    );
  }

  await prisma.$transaction(ops);

  // 立刻作废旧会话（否则 30 秒的 auth 缓存窗口内，旧 token 仍然有效）
  invalidateAuthCache(user.id);

  return NextResponse.json({ success: true, username: user.username });
}
