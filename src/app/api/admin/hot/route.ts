import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();

  if (q) {
    const articles = await prisma.article.findMany({
      where: {
        status: "published",
        title: { contains: q, mode: "insensitive" },
      },
      select: {
        id: true, title: true, upvotes: true, downvotes: true,
        replyCount: true, viewCount: true, createdAt: true,
        hotOverride: true, hotSortOrder: true,
        author: { select: { username: true } },
        board: { select: { name: true } },
      },
      take: 20,
      orderBy: { createdAt: "desc" },
    });
    return Response.json({ results: articles.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })) });
  }

  // Data source aligned with the forum home page hot tab (forum/page.tsx):
  //   - candidate window: latest 100 published posts (was: 30-day window)
  //   - boardId not null (was: no board filter — orphan posts leaked in here)
  // Visibility (public/private) is intentionally NOT filtered, so admins can
  // still manage the hot ranking of private posts — that asymmetry vs the home
  // page (which hides others' private posts) is by design.
  const baseWhere = { status: "published" as const, boardId: { not: null } };

  const recent = await prisma.article.findMany({
    where: baseWhere,
    select: {
      id: true, title: true, upvotes: true, downvotes: true,
      replyCount: true, viewCount: true, createdAt: true,
      lastRepliedAt: true, videoUrl: true, content: true,
      hotOverride: true, hotSortOrder: true,
      author: { select: { username: true } },
      board: { select: { name: true } },
    },
    take: 100,
    orderBy: { createdAt: "desc" },
  });
  // Manually pinned/demoted posts may be older than the latest 100; fetch them
  // separately so they stay manageable (mirrors the home page's pinnedRows query).
  const overrides = await prisma.article.findMany({
    where: { ...baseWhere, hotOverride: { not: null } },
    select: {
      id: true, title: true, upvotes: true, downvotes: true,
      replyCount: true, viewCount: true, createdAt: true,
      lastRepliedAt: true, videoUrl: true, content: true,
      hotOverride: true, hotSortOrder: true,
      author: { select: { username: true } },
      board: { select: { name: true } },
    },
  });
  const seenIds = new Set(recent.map((a) => a.id));
  const articles = [...recent, ...overrides.filter((a) => !seenIds.has(a.id))];

  const now = Date.now();
  const scored = articles.map((a) => {
    const net = Math.max(0, a.upvotes - a.downvotes);
    const score = Math.log1p(net) * 6 + Math.log1p(a.replyCount) * 4 + Math.log1p(Math.min(a.viewCount, 1000)) * 0.2;
    const coverImage = a.content.match(/<img[^>]+src="/)?.[0] ? 1 : 0;
    const boost = (a.videoUrl || coverImage) ? 1.3 : 1;
    const ref = a.lastRepliedAt || a.createdAt;
    const age = Math.min((now - ref.getTime()) / 3600000, 720);
    const timeBonus = 1 + 0.3 / (1 + age / 48);
    return {
      id: a.id, title: a.title, upvotes: a.upvotes, downvotes: a.downvotes,
      replyCount: a.replyCount, viewCount: a.viewCount, createdAt: a.createdAt.toISOString(),
      hotScore: Math.round(score * boost * timeBonus * 100) / 100,
      hotOverride: a.hotOverride, hotSortOrder: a.hotSortOrder,
      author: a.author, board: a.board,
    };
  });

  const pinned = scored.filter((a) => a.hotOverride === "pinned").sort((a, b) => (b.hotSortOrder || 0) - (a.hotSortOrder || 0));
  const auto = scored.filter((a) => !a.hotOverride).sort((a, b) => b.hotScore - a.hotScore);
  const demoted = scored.filter((a) => a.hotOverride === "demoted");

  return Response.json({ pinned, auto: auto.slice(0, 50), demoted });
}

export async function PUT(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  const body = await req.json();
  const { articleId, action, sortOrder } = body;
  if (!articleId || !action) return Response.json({ error: "缺少参数" }, { status: 400 });

  let data: Record<string, unknown>;
  switch (action) {
    case "pin":
      data = { hotOverride: "pinned", hotSortOrder: sortOrder ?? 100 };
      break;
    case "unpin":
      data = { hotOverride: null, hotSortOrder: null };
      break;
    case "demote":
      data = { hotOverride: "demoted", hotSortOrder: null };
      break;
    case "restore":
      data = { hotOverride: null, hotSortOrder: null };
      break;
    case "reorder":
      data = { hotSortOrder: sortOrder ?? 100 };
      break;
    default:
      return Response.json({ error: "未知操作" }, { status: 400 });
  }

  const article = await prisma.article.update({ where: { id: articleId }, data });
  return Response.json({ ok: true, article: { id: article.id, hotOverride: article.hotOverride, hotSortOrder: article.hotSortOrder } });
}
