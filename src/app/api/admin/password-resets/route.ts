import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin-auth";
import { compareAnswers, RESET_STATUS, summarizeChecks } from "@/lib/password-reset";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/password-resets —— 待处理的密码重置申请。
 *
 * 用户在登录页点「忘记密码」会在这里留下一条申请（站内没有邮件通道，
 * 管理员只能在这里看到）。后台「用户管理」页的顶部会列出来。
 *
 * 每条申请都**自动比对**用户填的答案与系统真值，逐题给出
 * 「吻合 / 接近 / 对不上 / 无法核对」—— 站长看到的是判断依据，不是原始
 * 数字，让他自己心算。
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

  // 逐个算「收到的赞」—— 与用户主页显示的口径一致（只计真人点赞）。
  const articleIds = requests.map((r) => r.user.id);
  const likeCounts = new Map<string, number>();
  if (articleIds.length > 0) {
    const rows = await prisma.$queryRaw<Array<{ authorId: string; n: bigint }>>`
      SELECT a."authorId", count(*)::bigint AS n
      FROM likes l
      JOIN articles a ON a.id = l."articleId"
      JOIN users u ON u.id = l."userId"
      WHERE a."authorId" = ANY(${articleIds}::text[])
        AND u."isSynthetic" = false
      GROUP BY a."authorId"
    `;
    for (const row of rows) likeCounts.set(row.authorId, Number(row.n));
  }

  return Response.json({
    requests: requests.map((r) => {
      const facts = {
        registeredAt: r.user.createdAt.toISOString(),
        lastLoginAt: r.user.lastLoginAt?.toISOString() ?? null,
        region: r.user.registrationRegion,
        articles: r.user._count.articles,
        comments: r.user._count.comments,
        upvotes: likeCounts.get(r.user.id) ?? 0,
      };
      const answers = (r.answers ?? {}) as Record<string, string | null>;
      const checks = compareAnswers(answers, facts);
      return {
        id: r.id,
        note: r.note,
        requestIp: r.requestIp,
        createdAt: r.createdAt.toISOString(),
        /** 逐题比对结果 —— 站长的判断依据 */
        checks,
        summary: summarizeChecks(checks),
        user: {
          id: r.user.id,
          uid: r.user.uid,
          username: r.user.username,
          email: r.user.email,
          registeredAt: facts.registeredAt,
          lastLoginAt: facts.lastLoginAt,
          registrationIp: r.user.registrationIp,
          registrationRegion: r.user.registrationRegion,
          articles: facts.articles,
          comments: facts.comments,
          upvotes: facts.upvotes,
        },
      };
    }),
  });
}
