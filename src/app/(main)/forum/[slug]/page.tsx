import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import Link from "next/link";
import { notFound } from "next/navigation";
import ForumSidebar from "@/components/forum-sidebar";
import LatestPosts from "@/components/latest-posts";
import BoardModerator from "@/components/board-moderator";
import { BoardThreadList, BoardPagination } from "@/components/board-thread-list";
import { loadBoardThreads } from "@/lib/board-threads";
import { parsePage } from "@/lib/pagination";
import { safeJsonLdStringify } from "@/lib/json-ld";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string; sort?: string }>;
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

        {/* Thread list + pagination — shared with /tw/forum/[slug] */}
        <BoardThreadList locale="zh-CN" threads={threads} voteMap={voteMap} />
        <BoardPagination locale="zh-CN" slug={slug} page={page} totalPages={totalPages} sort={sort} />
      </div>
      <LatestPosts />
    </div>
  );
}
