import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { visibleArticleWhere } from "@/lib/article-visibility";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  const type = searchParams.get("type") || "posts";
  if (!q) return NextResponse.json({ articles: [], tastingNotes: [] });

  const session = await auth();
  const userId = session?.user?.id ?? null;

  // Forum posts
  const articles = await (async () => {
    try {
      return await prisma.$queryRaw<Array<{
        id: string; title: string; upvotes: number; downvotes: number;
        replycount: number; createdat: Date; videourl: string | null;
        board_slug: string | null; board_name: string | null;
        author_id: string; author_username: string;
      }>>`
        SELECT a.id, a.title, a.upvotes, a.downvotes, a."replyCount",
               a."createdAt", a."videoUrl",
               b.slug as board_slug, b.name as board_name,
               u.id as author_id, u.username as author_username
        FROM articles a
        LEFT JOIN boards b ON a."boardId" = b.id
        JOIN users u ON a."authorId" = u.id
        WHERE a.status = 'published' AND a."boardId" IS NOT NULL
          AND (a.visibility <> 'private' OR a."authorId" = ${userId})
          AND (to_tsvector('simple', a.title || ' ' || a.content) @@ plainto_tsquery('simple', ${q})
               OR a.title ILIKE ${'%' + q + '%'})
        ORDER BY
          CASE WHEN a.title ILIKE ${q + '%'} THEN 0 WHEN a.title ILIKE ${'%' + q + '%'} THEN 1 ELSE 2 END,
          ts_rank(to_tsvector('simple', a.title || ' ' || a.content), plainto_tsquery('simple', ${q})) DESC,
          a."createdAt" DESC
        LIMIT 50
      `;
    } catch {
      return await prisma.article.findMany({
        where: { ...visibleArticleWhere(userId), boardId: { not: null }, AND: [{ OR: [{ title: { contains: q, mode: "insensitive" } }, { content: { contains: q, mode: "insensitive" } }] }] },
        orderBy: { createdAt: "desc" }, take: 50,
        select: { id: true, title: true, upvotes: true, downvotes: true, replyCount: true, createdAt: true, videoUrl: true, board: { select: { slug: true, name: true } }, author: { select: { id: true, username: true } } },
      }).then((rows) => rows.map((r) => ({ ...r, replycount: r.replyCount, createdat: r.createdAt, videourl: r.videoUrl, board_slug: r.board?.slug, board_name: r.board?.name, author_id: r.author.id, author_username: r.author.username })));
    }
  })();

  // Tasting notes are admin-only; only return in "all" mode for admins
  const isAdmin = session?.user?.role === "admin";
  const tastingNotes = type === "all" && isAdmin ? await (async () => {
    try {
      return await prisma.$queryRaw<Array<{
        id: string; title: string; createdat: Date;
        author_id: string; author_username: string;
        tea_name: string; tea_brand: string;
      }>>`
        SELECT tn.id, tn.title, tn."createdAt",
               u.id as author_id, u.username as author_username,
               t.name as tea_name, t.brand as tea_brand
        FROM tasting_notes tn
        JOIN users u ON tn."authorId" = u.id
        JOIN teas t ON tn."teaId" = t.id
        WHERE to_tsvector('simple', tn.title || ' ' || coalesce(tn.content,'') || ' ' || coalesce(tn.summary,''))
                @@ plainto_tsquery('simple', ${q})
           OR tn.title ILIKE ${'%' + q + '%'}
        ORDER BY
          ts_rank(to_tsvector('simple', tn.title || ' ' || coalesce(tn.content,'') || ' ' || coalesce(tn.summary,'')),
                  plainto_tsquery('simple', ${q})) DESC,
          tn."createdAt" DESC
        LIMIT 3
      `;
    } catch {
      return await prisma.tastingNote.findMany({
        where: { OR: [{ title: { contains: q, mode: "insensitive" } }, { content: { contains: q, mode: "insensitive" } }] },
        orderBy: { createdAt: "desc" }, take: 3,
        select: { id: true, title: true, createdAt: true, tea: { select: { name: true, brand: true } }, author: { select: { id: true, username: true } } },
      }).then((rows) => rows.map((r) => ({ ...r, createdat: r.createdAt, author_id: r.author.id, author_username: r.author.username, tea_name: r.tea.name, tea_brand: r.tea.brand })));
    }
  })() : [];

  return NextResponse.json({
    articles: articles.map((a: Record<string, unknown>) => ({
      id: a.id, title: a.title, upvotes: a.upvotes, downvotes: a.downvotes,
      replyCount: a.replycount, createdAt: a.createdat, videoUrl: a.videourl ?? null,
      board: a.board_slug ? { slug: a.board_slug, name: a.board_name } : null,
      author: { id: a.author_id, username: a.author_username },
    })),
    tastingNotes: tastingNotes.map((tn: Record<string, unknown>) => ({
      id: tn.id, title: tn.title, createdAt: tn.createdat,
      tea: { name: tn.tea_name, brand: tn.tea_brand },
      author: { id: tn.author_id, username: tn.author_username },
    })),
  });
}
