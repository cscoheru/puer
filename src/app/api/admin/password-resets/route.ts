import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin-auth";
import { RESET_STATUS } from "@/lib/password-reset";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/password-resets —— 待处理的密码重置申请。
 *
 * 用户在登录页点「忘记密码」会在这里留下一条申请（站内没有邮件通道，
 * 管理员只能在这里看到）。后台「用户管理」页的顶部会列出来。
 */
export async function GET() {
  const { error } = await requirePermission("admin:users");
  if (error) return error;

  const requests = await prisma.passwordResetRequest.findMany({
    where: { status: RESET_STATUS.pending },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      note: true,
      createdAt: true,
      user: {
        select: { id: true, uid: true, username: true, email: true },
      },
    },
  });

  return Response.json({
    requests: requests.map((r) => ({
      id: r.id,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
      user: r.user,
    })),
  });
}
