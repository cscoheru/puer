import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { requirePermission } from "@/lib/admin-auth";
import { resetPasswordSchema } from "@/lib/password-reset";

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

  const body = await req.json().catch(() => ({}));
  const parsed = resetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "密码不合法" },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, username: true, isSynthetic: true },
  });
  if (!user) {
    return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const now = new Date();

  const ops: Prisma.PrismaPromise<unknown>[] = [
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordChangedAt: now },
    }),
  ];
  // 自动化账号是机器，发通知没有意义（它们也不会看站内信）。
  if (!user.isSynthetic) {
    ops.push(
      prisma.notification.create({
        data: {
          userId: user.id,
          type: "system",
          content: "你的密码已被管理员重置。如果不是本人操作，请立即联系站长。",
          link: null,
        },
      }),
    );
  }

  await prisma.$transaction(ops);

  return NextResponse.json({ success: true, username: user.username });
}
