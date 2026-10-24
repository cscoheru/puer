import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin-auth";
import { RESET_STATUS } from "@/lib/password-reset";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/password-resets —— 待处理的密码重置申请。
 *
 * 用户在登录页点「忘记密码」会在这里留下一条申请（站内没有邮件通道，
 * 管理员只能在这里看到）。后台「用户管理」页的顶部会列出来。
 *
 * 每条申请**并排给出「用户填的」与「站点知道的」**：站长据此客观判断
 * 是不是本人，而不是凭感觉批准。
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
      // 只给「有没有自设密码」这个标志，**不给哈希本身**
      passwordHash: true,
      answers: true,
      requestIp: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          uid: true,
          username: true,
          email: true,
          createdAt: true,
          lastLoginAt: true,
          registrationIp: true,
          registrationRegion: true,
          _count: { select: { articles: true, comments: true } },
        },
      },
    },
  });

  return Response.json({
    requests: requests.map((r) => ({
      id: r.id,
      note: r.note,
      // 用户自己定了新密码 → 批准即生效，管理员不用再设
      selfPassword: r.passwordHash != null,
      // 用户填的核验答案
      answers: (r.answers ?? {}) as Record<string, string | null>,
      requestIp: r.requestIp,
      createdAt: r.createdAt.toISOString(),
      // 站点知道的真值 —— 供站长对照
      user: {
        id: r.user.id,
        uid: r.user.uid,
        username: r.user.username,
        email: r.user.email,
        registeredAt: r.user.createdAt.toISOString(),
        lastLoginAt: r.user.lastLoginAt?.toISOString() ?? null,
        registrationIp: r.user.registrationIp,
        registrationRegion: r.user.registrationRegion,
        articles: r.user._count.articles,
        comments: r.user._count.comments,
      },
    })),
  });
}
