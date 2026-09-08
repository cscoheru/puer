import { prisma } from "@/lib/prisma";
import DashboardClient from "@/components/admin/dashboard-client";

export default async function AdminDashboardPage() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

  const [
    totalUsers,
    todayUsers,
    yesterdayUsers,
    todayArticles,
    yesterdayArticles,
    activeSessions,
    pendingReports,
    recentArticles,
    recentComments,
    recentReports,
    userTrend,
    articleTrend,
    totalViewsAgg,
    totalVotes,
    todayVotes,
    yesterdayVotes,
    totalLikes,
    todayLikes,
    yesterdayLikes,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.user.count({ where: { createdAt: { gte: yesterdayStart, lt: todayStart } } }),
    prisma.article.count({ where: { createdAt: { gte: todayStart }, status: "published" } }),
    prisma.article.count({ where: { createdAt: { gte: yesterdayStart, lt: todayStart }, status: "published" } }),
    prisma.teaSession.count({ where: { status: { in: ["inviting", "confirmed", "live"] } } }),
    prisma.report.count({ where: { status: "pending" } }),
    prisma.article.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, createdAt: true, author: { select: { username: true } } },
    }),
    prisma.comment.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { id: true, content: true, createdAt: true, author: { select: { username: true } }, article: { select: { id: true, title: true } } },
    }),
    prisma.report.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { id: true, targetType: true, reason: true, createdAt: true, reporter: { select: { username: true } } },
    }),
    // 30-day user registration trend
    prisma.$queryRaw<Array<{ date: string; count: bigint }>>`
      SELECT DATE("createdAt") as date, COUNT(*)::bigint as count
      FROM users WHERE "createdAt" >= ${thirtyDaysAgo}
      GROUP BY DATE("createdAt") ORDER BY date
    `,
    // 30-day article trend
    prisma.$queryRaw<Array<{ date: string; count: bigint }>>`
      SELECT DATE("createdAt") as date, COUNT(*)::bigint as count
      FROM articles WHERE "createdAt" >= ${thirtyDaysAgo} AND status = 'published'
      GROUP BY DATE("createdAt") ORDER BY date
    `,
    // Engagement metrics: total views (cumulative), votes & likes (today vs yesterday)
    prisma.article.aggregate({ _sum: { viewCount: true } }),
    prisma.vote.count(),
    prisma.vote.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.vote.count({ where: { createdAt: { gte: yesterdayStart, lt: todayStart } } }),
    prisma.like.count(),
    prisma.like.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.like.count({ where: { createdAt: { gte: yesterdayStart, lt: todayStart } } }),
  ]);

  const metrics = {
    totalUsers,
    todayUsers,
    yesterdayUsers,
    todayArticles,
    yesterdayArticles,
    activeSessions,
    pendingReports,
  };

  const activities = [
    ...recentArticles.map((a) => ({
      type: "article" as const,
      id: a.id,
      title: a.title,
      user: a.author.username,
      createdAt: a.createdAt.toISOString(),
    })),
    ...recentComments.map((c) => ({
      type: "comment" as const,
      id: c.article?.id || c.id,
      title: c.content.slice(0, 50),
      user: c.author.username,
      createdAt: c.createdAt.toISOString(),
    })),
    ...recentReports.map((r) => ({
      type: "report" as const,
      id: r.id,
      title: `[${r.targetType}] ${r.reason.slice(0, 50)}`,
      user: r.reporter.username,
      createdAt: r.createdAt.toISOString(),
    })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 10);

  // 7-day view trend: daily view deltas from cumulative snapshots.
  // viewCount has no per-day history, so site_daily_stats (daily snapshot
  // taken by cron at 00:05) is the only source. Only days with a prior
  // baseline yield a delta — the series fills in day by day from today.
  // Tolerate table absence (dropped during --accept-data-loss schema push
  // without the cron being re enabled) — empty trend is honest when there
  // are no snapshots; an unhandled exception would 500 the whole admin page.
  const viewSnapshots = await (async () => {
    try {
      return await prisma.$queryRaw<Array<{ date: string; totalViews: bigint }>>`
        SELECT date::text, "totalViews"::bigint FROM site_daily_stats
        WHERE date >= CURRENT_DATE - INTERVAL '8 days' ORDER BY date
      `;
    } catch (e) {
      console.warn("[admin/page] site_daily_stats unavailable, returning empty trend:", e);
      return [] as Array<{ date: string; totalViews: bigint }>;
    }
  })();
  const viewTrend = viewSnapshots
    .map((row, i) => ({
      date: row.date,
      count: i > 0 ? Math.max(0, Number(row.totalViews) - Number(viewSnapshots[i - 1].totalViews)) : 0,
    }))
    .slice(1);

  const trend = {
    users: userTrend.map((r) => ({ date: r.date, count: Number(r.count) })),
    articles: articleTrend.map((r) => ({ date: r.date, count: Number(r.count) })),
    views: viewTrend,
  };

  const engagement = {
    totalViews: totalViewsAgg._sum.viewCount ?? 0,
    totalVotes,
    todayVotes,
    yesterdayVotes,
    totalLikes,
    todayLikes,
    yesterdayLikes,
  };

  return <DashboardClient metrics={metrics} activities={activities} trend={trend} engagement={engagement} />;
}
