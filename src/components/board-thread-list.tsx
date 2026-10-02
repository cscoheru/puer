/**
 * Board thread list and pagination, shared by `/forum/[slug]` and
 * `/tw/forum/[slug]`.
 *
 * The two pages render the *same* board. Before this file existed each one
 * carried its own copy of the row markup, which meant a change to the card — a
 * thumbnail size, a vote affordance — had to be made twice and could be made
 * once. Everything that differs between them collapses to a single `locale`
 * argument:
 *
 *   - DB-sourced text goes through `convertText` on the traditional side only.
 *   - UI chrome goes through the same, but the labels are converted once at
 *     module load (see `TW_LABELS`) because `convertText` hashes its input on
 *     every call even when it hits the cache.
 *   - In-tree links go through `twHref(locale, …)`, which returns its argument
 *     unchanged for `zh-CN` — so routing through it costs the simplified side
 *     nothing and keeps the path rules in one place. `/user/{id}` is the one
 *     exception: both sides link bare, and prefixing it would change the
 *     traditional URL.
 *
 * Two rendering details are load-bearing and easy to lose in a refactor:
 *
 *   1. **SSR separators count text children.** React inserts `<!-- -->` between
 *      each pair of adjacent text children, whether the child is a JSX literal
 *      or an expression. The simplified page's reply count renders as
 *      `💬 <!-- -->N<!-- --> 评论` — three text children — so the shared markup
 *      must keep that count and fold the space into `commentSuffix`. Collapsing
 *      it into one template literal (the tidy-looking version) drops both
 *      separators and changes the simplified page's bytes.
 *   2. **`extractFeedImages` is mandatory** (AGENTS.md R26). Tea-draft
 *      auto-posts keep their images in the `images` field with plain-text
 *      `content`, so a regex over `content` denies them their thumbnail.
 */
import Link from "next/link";
import VoteButton from "@/components/vote-button";
import { extractFeedImages } from "@/lib/forum-feed-server";
import { pageWindow, sortSuffix } from "@/lib/pagination";
import { convertText } from "@/lib/s2t";
import { twHref } from "@/i18n/translations";
import type { BoardThreadRow } from "@/lib/board-threads";

export type BoardLocale = "zh-CN" | "zh-TW";

interface BoardLabels {
  justNow: string;
  minutesAgo: string;
  hoursAgo: string;
  daysAgo: string;
  /**
   * Appended to the reply count as a single text child, **leading space
   * included**. The space must not be typed into the JSX between
   * `{replyCount}` and this label: that would make a fourth text child and SSR
   * would add another `<!-- -->`, changing the simplified page's bytes. See the
   * note at the top of this file.
   */
  commentSuffix: string;
  empty: string;
  prevPage: string;
  nextPage: string;
}

const SC_LABELS: BoardLabels = {
  justNow: "刚刚",
  minutesAgo: "分钟前",
  hoursAgo: "小时前",
  daysAgo: "天前",
  commentSuffix: " 评论",
  empty: "暂无帖子",
  prevPage: "上一页",
  nextPage: "下一页",
};

/** Converted once, at module load — `convertText` hashes on every call. */
const TW_LABELS: BoardLabels = {
  justNow: convertText(SC_LABELS.justNow),
  minutesAgo: convertText(SC_LABELS.minutesAgo),
  hoursAgo: convertText(SC_LABELS.hoursAgo),
  daysAgo: convertText(SC_LABELS.daysAgo),
  // The space is prepended rather than run through convertText so the glyph
  // conversion only ever sees the word it has to convert.
  commentSuffix: " " + convertText("评论"),
  empty: convertText(SC_LABELS.empty),
  prevPage: convertText(SC_LABELS.prevPage),
  nextPage: convertText(SC_LABELS.nextPage),
};

function labelsFor(locale: BoardLocale): BoardLabels {
  return locale === "zh-TW" ? TW_LABELS : SC_LABELS;
}

/** Relative time. The label is separated by a space on both locales. */
function timeAgo(d: Date, l: BoardLabels): string {
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return l.justNow;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} ${l.minutesAgo}`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} ${l.hoursAgo}`;
  return `${Math.floor(diff / 86400000)} ${l.daysAgo}`;
}

/**
 * DB text → display text. A no-op on the simplified side, which is what lets
 * every call site be unconditional instead of carrying a `locale` branch.
 */
function text(locale: BoardLocale, s: string): string {
  return locale === "zh-TW" ? convertText(s) : s;
}

export function BoardThreadList({
  locale,
  threads,
  voteMap,
}: {
  locale: BoardLocale;
  threads: BoardThreadRow[];
  voteMap: ReadonlyMap<string, number>;
}) {
  const labels = labelsFor(locale);

  if (threads.length === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-stone-400 text-sm">{labels.empty}</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-stone-100 bg-white border border-stone-200 rounded-lg overflow-hidden">
      {threads.map((thread) => {
        // R26：content ∪ images 字段（茶记自动帖的图只在 images 里）
        const { coverImage } = extractFeedImages({
          content: thread.content || "",
          images: thread.images ?? null,
        });
        const plainText = text(locale, (thread.content || "").replace(/<[^>]*>/g, "").trim().slice(0, 120));
        const replied = timeAgo(thread.lastRepliedAt || thread.createdAt, labels);
        const threadHref = twHref(locale, `/forum/thread/${thread.id}`);

        return (
          <div key={thread.id} className="flex gap-3 px-4 py-3 hover:bg-stone-50 transition">
            <div className="shrink-0 pt-0.5">
              <VoteButton refId={thread.id} type="article" initialUpvotes={thread.upvotes} initialDownvotes={thread.downvotes} initialValue={voteMap.get(thread.id) || 0} size="sm" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-xs text-stone-400 mb-0.5">
                {/* Bare on purpose — both sides link to /user/{id}. */}
                <Link href={`/user/${thread.author.id}`} className="hover:text-amber-700 font-medium text-stone-500">{thread.author.username}</Link>
                <span>·</span>
                <span>{replied}</span>
              </div>
              <Link href={threadHref} className="block">
                <h2 className="text-base font-semibold text-stone-800 hover:text-amber-800 leading-snug">
                  {thread.isPinned && <span className="text-xs text-blue-600 font-medium mr-1">📌</span>}
                  {thread.isEssence && <span className="text-xs text-amber-600 font-medium mr-1">💎</span>}
                  {text(locale, thread.title)}
                </h2>
              </Link>
              {plainText && <p className="text-xs text-stone-500 mt-1 leading-relaxed line-clamp-2">{plainText}</p>}
              <div className="flex items-center gap-3 mt-1.5 text-xs text-stone-400">
                <span>👍 {Math.max(0, thread.upvotes - thread.downvotes)}</span>
                {/* Exactly three text children: `💬 `, the count, and the
                    suffix (space included). No space between the braces — see
                    `commentSuffix`. */}
                <Link href={threadHref} className="hover:text-stone-600">💬 {thread.replyCount}{labels.commentSuffix}</Link>
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
  );
}

/**
 * Page links for a board.
 *
 * The numbered row renders `pageWindow` — first, last and the current page ±2
 * with `…` for each gap — rather than the `Math.min(totalPages, 10)` the board
 * pages used to inline. That form always printed 1-10, so a reader on page 37
 * saw ten page numbers none of which was theirs, and could only advance one
 * page at a time. The window is the shape `src/app/(main)/tea/page.tsx` already
 * uses; see `@/lib/pagination`.
 */
export function BoardPagination({
  locale,
  slug,
  page,
  totalPages,
  sort,
}: {
  locale: BoardLocale;
  slug: string;
  page: number;
  totalPages: number;
  /**
   * The active sort, already normalised by the page to `"latest"` or nothing.
   * Typed as the literal rather than `string` so raw `searchParams.sort` cannot
   * be handed straight to `sortSuffix` and echoed into an href.
   */
  sort?: "latest";
}) {
  const labels = labelsFor(locale);
  if (totalPages <= 1) return null;

  const boardHref = twHref(locale, `/forum/${slug}`);
  const suffix = sortSuffix(sort);

  return (
    <div className="flex items-center justify-center gap-2 mt-6">
      {page > 1 && <Link href={`${boardHref}?page=${page - 1}${suffix}`} className="px-2.5 py-1.5 text-xs border border-stone-300 rounded hover:border-amber-300 transition text-stone-600">{labels.prevPage}</Link>}
      {pageWindow(page, totalPages).map((p, i) =>
        // `…` marks a gap; it is not a page and must not become a link.
        p === "…" ? (
          <span key={`gap-${i}`} className="px-2.5 py-1.5 text-xs text-stone-400">…</span>
        ) : (
          <Link key={p} href={`${boardHref}?page=${p}${suffix}`}
            className={`px-2.5 py-1.5 text-xs rounded border transition ${p === page ? "bg-amber-800 text-white border-amber-800" : "border-stone-300 text-stone-600 hover:border-amber-300"}`}>{p}</Link>
        ),
      )}
      {page < totalPages && <Link href={`${boardHref}?page=${page + 1}${suffix}`} className="px-2.5 py-1.5 text-xs border border-stone-300 rounded hover:border-amber-300 transition text-stone-600">{labels.nextPage}</Link>}
    </div>
  );
}
