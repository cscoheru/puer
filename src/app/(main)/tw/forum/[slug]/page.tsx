/**
 * /tw/forum/[slug] — Traditional Chinese mirror of /forum/[slug].
 *
 * Data comes from the same `loadBoardThreads()` the simplified page calls, so
 * ordering, ranking and pagination are identical across the two URLs — the
 * reader sees the same board, just in traditional glyphs. Only the presentation
 * layer differs: DB-sourced text goes through s2tw, UI chrome through
 * `convertText`, and in-tree links go through `twHref` so a click does not drop
 * the reader back onto the simplified site (or, worse, onto a 404).
 *
 * The thread list and the pager themselves live in
 * `@/components/board-thread-list`, shared with the simplified page and
 * parameterised on `locale` — see that file for the glyph/routing rules. What
 * stays here is the page's own chrome: metadata, JSON-LD, the board header and
 * the sort tabs.
 *
 * canonical stays on /forum/[slug] (the DB-authoritative copy). JSON-LD here is
 * BreadcrumbList only.
 */
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
import { convertText } from "@/lib/s2t";
import { twHref, NON_MIRRORED_FORUM_SEGMENTS } from "@/i18n/translations";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const board = await prisma.board.findUnique({ where: { slug }, select: { name: true, description: true } });
  if (!board) return { title: convertText("版块未找到"), robots: { index: false, follow: false } };
  const twName = convertText(board.name);
  const description = convertText(board.description || `${board.name} — 普洱茶论坛版块`);
  return {
    title: convertText(`${board.name}版块`),
    description,
    // Same shape as the TW thread page: the array field needs an explicit map,
    // and the two literals are converted too — a TW document should not carry
    // simplified glyphs anywhere in its head.
    keywords: [board.name, "普洱茶", "品茶", "茶友交流"].map(convertText),
    alternates: {
      // Canonical points to SC (DB-authoritative copy).
      canonical: `/forum/${slug}`,
      languages: {
        "zh-Hans-CN": `/forum/${slug}`,
        "zh-Hant-TW": `/tw/forum/${slug}`,
        "x-default": `/forum/${slug}`,
      },
    },
    openGraph: {
      title: twName,
      description,
      // Without this the document inherits Next's `zh_CN` default, which
      // contradicts the hreflang cluster above.
      locale: "zh_TW",
    },
  };
}

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string; sort?: string }>;
}

export default async function TwBoardPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const { page: pageStr, sort: rawSort } = await searchParams;
  const page = parsePage(pageStr);
  // Only "latest" is a meaningful non-default sort; anything else is the hot
  // ranking. Normalising here means the pagination links below can carry the
  // sort forward without echoing junk back into the URL.
  const sort = rawSort === "latest" ? "latest" : undefined;
  const session = await auth();

  // `/forum/classics` is the curated brand landing page; the board that shares
  // its slug is only reachable on the simplified side. Rendering it here would
  // give /tw/forum/classics a canonical of /forum/classics pointing at a
  // *different* page than this one — a non-reciprocal hreflang cluster. The
  // list is the same one `twHref` uses to refuse prefixing these links.
  if (NON_MIRRORED_FORUM_SEGMENTS.has(slug)) notFound();

  const board = await prisma.board.findUnique({ where: { slug } });
  if (!board) notFound();

  const { threads, total, totalPages, voteMap } = await loadBoardThreads({
    boardId: board.id,
    page,
    sort,
    userId: session?.user?.id,
  });

  const boardName = convertText(board.name);
  // Every in-tree link goes through twHref rather than a hand-built `/tw/...`
  // literal: the shape rules live in one place, and a path with no mirror
  // (`/forum/new`) is left unprefixed automatically instead of by hand.
  const boardHref = twHref("zh-TW", `/forum/${slug}`);

  return (
    <div className="flex gap-4 md:gap-6 px-2 md:px-4 max-w-screen-2xl mx-auto py-4">
      {/* BreadcrumbList JSON-LD — the only structured data on /tw/ pages. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLdStringify({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            inLanguage: "zh-TW",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: convertText("首頁"), item: "https://puer.im" },
              { "@type": "ListItem", position: 2, name: convertText("論壇"), item: "https://puer.im/forum" },
              { "@type": "ListItem", position: 3, name: boardName, item: `https://puer.im/forum/${slug}` },
            ],
          }),
        }}
      />
      <ForumSidebar locale="zh-TW" />
      <div className="flex-1 min-w-0">
        {/* Board header */}
        <div className="mb-4">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-xl md:text-2xl font-bold text-stone-800">{board.icon} {boardName}</h1>
              {board.description && <p className="text-stone-500 text-xs mt-0.5">{convertText(board.description)}</p>}
              <p className="text-xs text-stone-400 mt-1">{total} {convertText("个帖子")}</p>
            </div>
            <Link href={twHref("zh-TW", "/forum/new")} className="text-sm bg-amber-800 text-white px-4 py-2 rounded-lg hover:bg-amber-900 transition">{convertText("发布新帖")}</Link>
          </div>
          <BoardModerator boardSlug={slug} />
        </div>

        {/* Sort tabs */}
        <div className="flex items-center gap-1 mb-3">
          <Link href={boardHref} className={`text-xs px-2.5 py-1.5 rounded-lg transition ${sort === "latest" ? "bg-stone-100 text-stone-600" : "bg-amber-50 text-amber-800 font-medium"}`}>{convertText("热门")}</Link>
          <Link href={`${boardHref}?sort=latest`} className={`text-xs px-2.5 py-1.5 rounded-lg transition ${sort === "latest" ? "bg-amber-50 text-amber-800 font-medium" : "bg-stone-100 text-stone-600"}`}>{convertText("最新")}</Link>
          {totalPages > 1 && <span className="text-xs text-stone-400 ml-auto">{convertText(`第 ${page}/${totalPages} 页`)}</span>}
        </div>

        {/* Thread list + pagination — shared with /forum/[slug] */}
        <BoardThreadList locale="zh-TW" threads={threads} voteMap={voteMap} />
        <BoardPagination locale="zh-TW" slug={slug} page={page} totalPages={totalPages} sort={sort} />
      </div>
      <LatestPosts locale="zh-TW" />
    </div>
  );
}
