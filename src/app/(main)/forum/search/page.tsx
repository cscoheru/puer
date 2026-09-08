import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { visibleArticleWhere } from "@/lib/article-visibility";
import ForumFeed from "@/components/forum-feed";
import ForumSidebar from "@/components/forum-sidebar";
import LatestPosts from "@/components/latest-posts";
import Link from "next/link";

export const dynamic = "force-dynamic";

async function searchPosts(q: string, userId?: string | null) {
  try {
    return await prisma.$queryRaw<Array<{
      id: string; title: string; upvotes: number; downvotes: number;
      replycount: bigint; createdat: Date; videourl: string | null;
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
        AND (a.visibility <> 'private' OR a."authorId" = ${userId ?? null})
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
    });
  }
}

async function searchTastingNotes(q: string) {
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
      ORDER BY ts_rank(to_tsvector('simple', tn.title || ' ' || coalesce(tn.content,'') || ' ' || coalesce(tn.summary,'')),
              plainto_tsquery('simple', ${q})) DESC, tn."createdAt" DESC
      LIMIT 3
    `;
  } catch {
    return await prisma.tastingNote.findMany({
      where: { OR: [{ title: { contains: q, mode: "insensitive" } }, { content: { contains: q, mode: "insensitive" } }] },
      orderBy: { createdAt: "desc" }, take: 3,
      select: { id: true, title: true, createdAt: true, tea: { select: { name: true, brand: true } }, author: { select: { id: true, username: true } } },
    });
  }
}

export default async function SearchPage(props: {
  searchParams: Promise<{ q?: string; type?: string }>;
}) {
  const { q, type = "posts" } = await props.searchParams;
  const session = await auth();

  if (!q?.trim()) {
    return (
      <div className="text-center py-16">
        <p className="text-stone-400 text-sm">输入关键词搜索帖子</p>
      </div>
    );
  }

  const isFullSite = type === "all";

  // Run searches in parallel
  const [rawArticles, tastingNotes] = await Promise.all([
    searchPosts(q.trim(), session?.user?.id),
    isFullSite ? searchTastingNotes(q.trim()) : [],
  ]);

  // Normalize article data
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const articles = (rawArticles as any[]).map((a: any) => ({
    id: a.id,
    title: a.title,
    upvotes: Number(a.upvotes),
    downvotes: Number(a.downvotes),
    replyCount: Number(a.replyCount ?? a.replycount ?? 0),
    createdAt: a.createdAt instanceof Date ? a.createdAt.toISOString() : String(a.createdAt),
    videoUrl: a.videoUrl ?? a.videourl ?? null,
    board: a.board_slug ?? a.board?.slug ? { slug: a.board_slug ?? a.board.slug, name: a.board_name ?? a.board.name } : null,
    author: { id: a.author_id ?? a.author?.id, username: a.author_username ?? a.author?.username },
  }));

  // Normalize tasting notes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const notes = (tastingNotes as any[]).map((tn: any) => ({
    id: tn.id,
    title: tn.title,
    createdAt: tn.createdAt instanceof Date ? tn.createdAt.toISOString() : String(tn.createdAt),
    tea: { name: tn.tea_name ?? tn.tea?.name ?? "", brand: tn.tea_brand ?? tn.tea?.brand ?? "" },
    author: { id: tn.author_id ?? tn.author?.id ?? "", username: tn.author_username ?? tn.author?.username ?? "" },
  }));

  let voteMap = new Map<string, number>();
  if (session?.user?.id && articles.length > 0) {
    const votes = await prisma.vote.findMany({
      where: { userId: session.user.id, refId: { in: articles.map((a) => a.id) } },
      select: { refId: true, value: true },
    });
    votes.forEach((v) => voteMap.set(v.refId, v.value));
  }

  const feedArticles = articles.map((a) => ({
    id: a.id, title: a.title, upvotes: a.upvotes, downvotes: a.downvotes,
    replyCount: a.replyCount, createdAt: a.createdAt,
    isEssence: false, isPinned: false, content: "", videoUrl: a.videoUrl,
    flair: null, board: a.board,
    author: { id: a.author.id, username: a.author.username, avatar: null, level: 0, followerCount: 0, karma: 0 },
    initialVote: voteMap.get(a.id) || 0,
  }));

  const boards = await prisma.board.findMany({ orderBy: { sortOrder: "asc" } });
  const totalResults = articles.length + notes.length;

  return (
    <div className="flex gap-4 md:gap-6 px-2 md:px-4 max-w-screen-2xl mx-auto">
      <ForumSidebar />
      <div className="flex-1 min-w-0">
        <div className="mb-4">
          <h1 className="text-lg font-bold text-stone-800">搜索: &ldquo;{q}&rdquo;</h1>
          <p className="text-xs text-stone-400 mt-0.5">{totalResults} 个结果</p>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-2 mb-4">
          <Link href={`/forum/search?q=${encodeURIComponent(q)}&type=posts`}
            className={`text-xs px-3 py-1.5 rounded-full transition ${!isFullSite ? "bg-amber-600 text-white" : "bg-stone-100 text-stone-500 hover:bg-stone-200"}`}>帖子</Link>
          <Link href={`/forum/search?q=${encodeURIComponent(q)}&type=all`}
            className={`text-xs px-3 py-1.5 rounded-full transition ${isFullSite ? "bg-amber-600 text-white" : "bg-stone-100 text-stone-500 hover:bg-stone-200"}`}>全站</Link>
        </div>

        {/* Tasting note results (top 3) */}
        {isFullSite && notes.length > 0 && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <h2 className="text-xs font-semibold text-amber-800 mb-2">🍵 茶记（品鉴笔记）</h2>
            <div className="space-y-2">
              {notes.map((tn) => (
                <Link key={tn.id} href={`/tasting/${tn.id}`}
                  className="flex items-center gap-2 p-2 bg-white rounded-lg hover:bg-amber-50/50 transition">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-stone-800 truncate">{tn.title}</p>
                    <p className="text-xs text-stone-500">{tn.tea.brand} {tn.tea.name} · {tn.author.username}</p>
                  </div>
                  <span className="text-xs text-amber-600 shrink-0">查看 →</span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Forum results */}
        {articles.length === 0 && !isFullSite ? (
          <div className="text-center py-16 border border-dashed border-stone-200 rounded-lg bg-white">
            <p className="text-stone-300 text-lg mb-1">🔍</p>
            <p className="text-stone-400 text-sm">没有找到相关帖子</p>
          </div>
        ) : (
          <ForumFeed articles={feedArticles}
            boards={boards.map((b) => ({ id: b.id, name: b.name, slug: b.slug, icon: b.icon }))}
            currentUserId={session?.user?.id} tab="hot" />
        )}
      </div>
      <LatestPosts />
    </div>
  );
}
