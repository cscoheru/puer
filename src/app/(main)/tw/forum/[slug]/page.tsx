/**
 * /tw/forum/[slug] — Traditional Chinese mirror of /forum/[slug].
 *
 * Data comes from the same `loadBoardThreads()` the simplified page calls, so
 * ordering, ranking and pagination are identical across the two URLs — the
 * reader sees the same board, just in traditional glyphs. Only the presentation
 * layer differs: DB-sourced text goes through s2tw, UI chrome through the
 * zhCNtoTW map, and in-tree links go through `twHref` so a click does not drop
 * the reader back onto the simplified site (or, worse, onto a 404).
 *
 * canonical stays on /forum/[slug] (the DB-authoritative copy). JSON-LD here is
 * BreadcrumbList only.
 */
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
import { convertText } from "@/lib/s2t";
import { twHref, NON_MIRRORED_FORUM_SEGMENTS } from "@/i18n/translations";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

/** Fixed time labels, converted once at module load instead of per thread per
 *  render — `convertText` hashes its input on every call even on a cache hit. */
const T_JUST_NOW = convertText("刚刚");
const T_MINUTES_AGO = convertText("分钟前");
const T_HOURS_AGO = convertText("小时前");
const T_DAYS_AGO = convertText("天前");

/** Relative time with traditional labels. Mirrors the inline helper on the SC page. */
function timeAgo(d: Date): string {
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return T_JUST_NOW;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} ${T_MINUTES_AGO}`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} ${T_HOURS_AGO}`;
  return `${Math.floor(diff / 86400000)} ${T_DAYS_AGO}`;
}

/**
 * Parses `?page=`. `Math.max(1, parseInt(x))` alone is not enough: parseInt
 * returns NaN for garbage, and Math.max(1, NaN) is NaN, which reaches Prisma's
 * `skip` as NaN and 500s the whole board. The upper bound keeps a crafted
 * `?page=999999999999` from overflowing Prisma's 32-bit `skip`.
 */
function parsePage(raw: string | undefined): number {
  const n = parseInt(raw || "1", 10);
  return Number.isSafeInteger(n) && n > 0 && n <= 10000 ? n : 1;
}

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
  // Carry the active sort across pages. Emitting it only when it is *not*
  // "latest" silently dropped the 最新 tab on page 2 (the reader got the hot
  // ranking back), and emitted `&sort=undefined` when no sort was set at all.
  const sortSuffix = sort ? `&sort=${sort}` : "";

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

        {/* Thread list */}
        {threads.length > 0 ? (
          <div className="divide-y divide-stone-100 bg-white border border-stone-200 rounded-lg overflow-hidden">
            {threads.map((thread) => {
              // R26：content ∪ images 字段（茶记自动帖的图只在 images 里）
              const { coverImage } = extractFeedImages({
                content: thread.content || "",
                images: thread.images ?? null,
              });
              const plainText = convertText((thread.content || "").replace(/<[^>]*>/g, "").trim().slice(0, 120));
              const replied = timeAgo(thread.lastRepliedAt || thread.createdAt);
              const threadHref = twHref("zh-TW", `/forum/thread/${thread.id}`);

              return (
                <div key={thread.id} className="flex gap-3 px-4 py-3 hover:bg-stone-50 transition">
                  <div className="shrink-0 pt-0.5">
                    <VoteButton refId={thread.id} type="article" initialUpvotes={thread.upvotes} initialDownvotes={thread.downvotes} initialValue={voteMap.get(thread.id) || 0} size="sm" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-xs text-stone-400 mb-0.5">
                      <Link href={`/user/${thread.author.id}`} className="hover:text-amber-700 font-medium text-stone-500">{thread.author.username}</Link>
                      <span>·</span>
                      <span>{replied}</span>
                    </div>
                    <Link href={threadHref} className="block">
                      <h2 className="text-base font-semibold text-stone-800 hover:text-amber-800 leading-snug">
                        {thread.isPinned && <span className="text-xs text-blue-600 font-medium mr-1">📌</span>}
                        {thread.isEssence && <span className="text-xs text-amber-600 font-medium mr-1">💎</span>}
                        {convertText(thread.title)}
                      </h2>
                    </Link>
                    {plainText && <p className="text-xs text-stone-500 mt-1 leading-relaxed line-clamp-2">{plainText}</p>}
                    <div className="flex items-center gap-3 mt-1.5 text-xs text-stone-400">
                      <span>👍 {Math.max(0, thread.upvotes - thread.downvotes)}</span>
                      <Link href={threadHref} className="hover:text-stone-600">💬 {thread.replyCount} {convertText("评论")}</Link>
                    </div>
                  </div>
                  {coverImage ? (
                    <Link href={threadHref} className="shrink-0">
                      <div className="w-20 h-20 md:w-24 md:h-24 rounded-lg bg-stone-100 overflow-hidden"><img src={coverImage} alt="" className="w-full h-full object-cover" /></div>
                    </Link>
                  ) : thread.videoUrl ? (
                    <Link href={threadHref} className="shrink-0">
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
            <p className="text-stone-400 text-sm">{convertText("暂无帖子")}</p>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-6">
            {page > 1 && <Link href={`${boardHref}?page=${page - 1}${sortSuffix}`} className="px-2.5 py-1.5 text-xs border border-stone-300 rounded hover:border-amber-300 transition text-stone-600">{convertText("上一页")}</Link>}
            {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((p) => (
              <Link key={p} href={`${boardHref}?page=${p}${sortSuffix}`}
                className={`px-2.5 py-1.5 text-xs rounded border transition ${p === page ? "bg-amber-800 text-white border-amber-800" : "border-stone-300 text-stone-600 hover:border-amber-300"}`}>{p}</Link>
            ))}
            {page < totalPages && <Link href={`${boardHref}?page=${page + 1}${sortSuffix}`} className="px-2.5 py-1.5 text-xs border border-stone-300 rounded hover:border-amber-300 transition text-stone-600">{convertText("下一页")}</Link>}
          </div>
        )}
      </div>
      <LatestPosts locale="zh-TW" />
    </div>
  );
}
