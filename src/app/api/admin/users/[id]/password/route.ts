import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { requirePermission } from "@/lib/admin-auth";
import { invalidateAuthCache } from "@/lib/auth";
import { generateResetCode, hashResetCode } from "@/lib/password-reset";

export const dynamic = "force-dynamic";

/**
 * PUT /api/admin/users/[id]/password —— 直接给某个用户重置密码。
 *
 * 不需要用户先提交申请 —— 管理员在用户管理里看到某个用户联系不上，
 * 直接就能重置（这是「帮助用户进行密码重置」最直接的形态）。
 *
 * 两件事必须一起做：
 *   1. 换密码哈希 + 记 `passwordChangedAt`（旧会话靠它作废）
 *   2. 给本人发一条站内通知 —— 密码被别人改了，本人必须知道
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

  // 管理员**不碰别人的密码** —— 给他发一个重置码，他自己设。
  const code = generateResetCode();
  const passwordHash = await hashResetCode(code);
  const now = new Date();

  // 申请单上记一条 —— 站长日后能查到「给谁发过重置码」。
  const ops: Prisma.PrismaPromise<unknown>[] = [
    prisma.passwordResetRequest.create({
      data: {
        userId: user.id,
        status: "approved",
        note: "管理员直接发起",
        passwordHash,
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
          content: `管理员为你发起了一次密码重置。重置码：${code}。到登录页的「忘记密码」里用它设置新密码。如果不是本人操作，请立即联系站长。`,
          link: null,
        },
      }),
    );
  }

  await prisma.$transaction(ops);

  // 立刻作废旧会话（否则 30 秒的 auth 缓存窗口内，旧 token 仍然有效）
  invalidateAuthCache(user.id);

  return NextResponse.json({ success: true, username: user.username, code });
}
