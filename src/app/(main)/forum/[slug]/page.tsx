import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import Link from "next/link";
import { notFound } from "next/navigation";
import VoteButton from "@/components/vote-button";
import ForumSidebar from "@/components/forum-sidebar";
import LatestPosts from "@/components/latest-posts";
import BoardModerator from "@/components/board-moderator";
import { loadBoardThreads } from "@/lib/board-threads";
import { extractFeedImages } from "@/lib/forum-feed-server";
import { safeJsonLdStringify } from "@/lib/json-ld";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string; sort?: string }>;
}

/**
 * `Math.max(1, parseInt(x))` is not a guard: parseInt yields NaN for garbage
 * and Math.max(1, NaN) is NaN, which reaches Prisma's `skip` as NaN and 500s
 * the page. The upper bound keeps a crafted `?page=99999999999` from
 * overflowing Prisma's 32-bit `skip`. Mirrors the TW board page.
 */
function parsePage(raw: string | undefined): number {
  const n = parseInt(raw || "1", 10);
  return Number.isSafeInteger(n) && n > 0 && n <= 10000 ? n : 1;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const board = await prisma.board.findUnique({ where: { slug }, select: { name: true, description: true } });
  if (!board) return { title: "版块未找到" };
  return {
    title: `${board.name}版块`,
    description: board.description || `${board.name} — 普洱茶论坛版块`,
    keywords: [board.name, "普洱茶", "品茶", "茶友交流"],
    // 与 /forum 同一套三向 hreflang。canonical 留在简体（DB 权威版本）。
    alternates: {
      canonical: `/forum/${slug}`,
      languages: {
        "zh-Hans-CN": `/forum/${slug}`,
        "zh-Hant-TW": `/tw/forum/${slug}`,
        "x-default": `/forum/${slug}`,
      },
    },
  };
}

export default async function BoardPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const { page: pageStr, sort: rawSort } = await searchParams;
  const page = parsePage(pageStr);
  // Only "latest" is a meaningful non-default sort; anything else is the hot
  // ranking. Normalising keeps junk out of the pagination links below.
  const sort = rawSort === "latest" ? "latest" : undefined;
  const session = await auth();

  const board = await prisma.board.findUnique({ where: { slug } });
  if (!board) notFound();

  // 查询 + 热榜打分 + 分页全部在 lib 里，/tw/forum/[slug] 调同一个函数，
  // 保证两个 URL 下的排序和分页完全一致（见 lib/board-threads.ts 注释）。
  const { threads, total, totalPages, voteMap } = await loadBoardThreads({
    boardId: board.id,
    page,
    sort,
    userId: session?.user?.id,
  });

  // Carries the active sort across pages. The previous inline form emitted the
  // suffix whenever the sort was *not* "latest" — which dropped 最新 on page 2
  // (the reader silently got the hot ranking back) and produced
  // `&sort=undefined` when no sort was set at all.
  const sortSuffix = sort ? `&sort=${sort}` : "";

  return (
    <div className="flex gap-4 md:gap-6 px-2 md:px-4 max-w-screen-2xl mx-auto py-4">
      {/* BreadcrumbList JSON-LD */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLdStringify({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "首页", item: "https://puer.im" },
              { "@type": "ListItem", position: 2, name: "论坛", item: "https://puer.im/forum" },
              { "@type": "ListItem", position: 3, name: board.name, item: `https://puer.im/forum/${slug}` },
            ],
          }),
        }}
      />
      <ForumSidebar />
      <div className="flex-1 min-w-0">
        {/* Board header */}
        <div className="mb-4">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-xl md:text-2xl font-bold text-stone-800">{board.icon} {board.name}</h1>
              {board.description && <p className="text-stone-500 text-xs mt-0.5">{board.description}</p>}
              <p className="text-xs text-stone-400 mt-1">{total} 个帖子</p>
            </div>
            <Link href="/forum/new" className="text-sm bg-amber-800 text-white px-4 py-2 rounded-lg hover:bg-amber-900 transition">发布新帖</Link>
          </div>
          <BoardModerator boardSlug={slug} />
        </div>

        {/* Sort tabs */}
        <div className="flex items-center gap-1 mb-3">
          <Link href={`/forum/${slug}`} className={`text-xs px-2.5 py-1.5 rounded-lg transition ${sort === "latest" ? "bg-stone-100 text-stone-600" : "bg-amber-50 text-amber-800 font-medium"}`}>热门</Link>
          <Link href={`/forum/${slug}?sort=latest`} className={`text-xs px-2.5 py-1.5 rounded-lg transition ${sort === "latest" ? "bg-amber-50 text-amber-800 font-medium" : "bg-stone-100 text-stone-600"}`}>最新</Link>
          {totalPages > 1 && <span className="text-xs text-stone-400 ml-auto">第 {page}/{totalPages} 页</span>}
        </div>

        {/* Thread list */}
        {threads.length > 0 ? (
          <div className="divide-y divide-stone-100 bg-white border border-stone-200 rounded-lg overflow-hidden">
            {threads.map((thread) => {
              // R26：content ∪ images 字段（茶记自动帖的图只在 images 里）
              const { coverImage } = extractFeedImages({
                content: thread.content || "",
                images: thread.images ?? null,
              });
              const plainText = (thread.content || "").replace(/<[^>]*>/g, "").trim().slice(0, 120);
              const timeAgo = ((d: Date) => {
                const diff = Date.now() - d.getTime();
                if (diff < 60000) return "刚刚";
                if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
                if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
                return `${Math.floor(diff / 86400000)} 天前`;
              })(thread.lastRepliedAt || thread.createdAt);

              return (
                <div key={thread.id} className="flex gap-3 px-4 py-3 hover:bg-stone-50 transition">
                  <div className="shrink-0 pt-0.5">
                    <VoteButton refId={thread.id} type="article" initialUpvotes={thread.upvotes} initialDownvotes={thread.downvotes} initialValue={voteMap.get(thread.id) || 0} size="sm" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-xs text-stone-400 mb-0.5">
                      <Link href={`/user/${thread.author.id}`} className="hover:text-amber-700 font-medium text-stone-500">{thread.author.username}</Link>
                      <span>·</span>
                      <span>{timeAgo}</span>
                    </div>
                    <Link href={`/forum/thread/${thread.id}`} className="block">
                      <h2 className="text-base font-semibold text-stone-800 hover:text-amber-800 leading-snug">
                        {thread.isPinned && <span className="text-xs text-blue-600 font-medium mr-1">📌</span>}
                        {thread.isEssence && <span className="text-xs text-amber-600 font-medium mr-1">💎</span>}
                        {thread.title}
                      </h2>
                    </Link>
                    {plainText && <p className="text-xs text-stone-500 mt-1 leading-relaxed line-clamp-2">{plainText}</p>}
                    <div className="flex items-center gap-3 mt-1.5 text-xs text-stone-400">
                      <span>👍 {Math.max(0, thread.upvotes - thread.downvotes)}</span>
                      <Link href={`/forum/thread/${thread.id}`} className="hover:text-stone-600">💬 {thread.replyCount} 评论</Link>
                    </div>
                  </div>
                  {coverImage ? (
                    <Link href={`/forum/thread/${thread.id}`} className="shrink-0">
                      <div className="w-20 h-20 md:w-24 md:h-24 rounded-lg bg-stone-100 overflow-hidden"><img src={coverImage} alt="" className="w-full h-full object-cover" /></div>
                    </Link>
                  ) : thread.videoUrl ? (
                    <Link href={`/forum/thread/${thread.id}`} className="shrink-0">
                      <div className="w-20 h-20 md:w-24 md:h-24 rounded-lg bg-black overflow-hidden relative">
                        <video src={thread.videoUrl} preload="metadata" muted playsInline className="w-full h-full object-cover" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="w-6 h-6 bg-black/40 rounded-full flex items-center justify-center">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
                          </div>
                        </div>
                      </div>
                    </Link>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-16">
            <p className="text-stone-400 text-sm">暂无帖子</p>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-6">
            {page > 1 && <Link href={`/forum/${slug}?page=${page - 1}${sortSuffix}`} className="px-2.5 py-1.5 text-xs border border-stone-300 rounded hover:border-amber-300 transition text-stone-600">上一页</Link>}
            {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((p) => (
              <Link key={p} href={`/forum/${slug}?page=${p}${sortSuffix}`}
                className={`px-2.5 py-1.5 text-xs rounded border transition ${p === page ? "bg-amber-800 text-white border-amber-800" : "border-stone-300 text-stone-600 hover:border-amber-300"}`}>{p}</Link>
            ))}
            {page < totalPages && <Link href={`/forum/${slug}?page=${page + 1}${sortSuffix}`} className="px-2.5 py-1.5 text-xs border border-stone-300 rounded hover:border-amber-300 transition text-stone-600">下一页</Link>}
          </div>
        )}
      </div>
      <LatestPosts />
    </div>
  );
}
