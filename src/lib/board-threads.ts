/**
 * Board thread loading, shared by `/forum/[slug]` and `/tw/forum/[slug]`.
 *
 * The traditional-Chinese mirror must rank and paginate *identically* to the
 * simplified page — two readers looking at the same board through different
 * URLs are looking at the same content, and a second copy of this scoring
 * function would drift from the first the moment either is tuned.
 */
import { prisma } from "@/lib/prisma";
import { visibleArticleWhere } from "@/lib/article-visibility";
import { extractFeedImages } from "@/lib/forum-feed-server";
import { applyHotRank } from "@/lib/hot-rank";

export const ITEMS_PER_PAGE = 20;

export const BOARD_THREAD_SELECT = {
  id: true, title: true, content: true, videoUrl: true,
  // P2-R26：茶记自动帖图片存独立 images 字段（content 纯文字），select 必须带上，
  // 否则列表页缩略图和热榜 hasMedia 加权都拿不到图。
  images: true,
  upvotes: true, downvotes: true, replyCount: true, viewCount: true,
  isPinned: true, isEssence: true, hotOverride: true, hotSortOrder: true,
  createdAt: true, lastRepliedAt: true,
  author: { select: { id: true, username: true, avatar: true } },
} as const;

export type BoardThreadRow = Awaited<
  ReturnType<typeof prisma.article.findMany<{ select: typeof BOARD_THREAD_SELECT }>>
>[number];

/**
 * Ranking state — `hasMedia`, `_hotScore`, `_finalScore` — is bookkeeping for
 * the sort, not page data. Rows are rebuilt without it before they leave this
 * module so the values cannot ride along into page props: the same reasoning
 * that removed `_coverImage` from the scored rows. Doing it here rather than in
 * each caller means there is no second place to forget.
 */
function toBoardRow(
  row: (BoardThreadRow & { hasMedia: boolean }) & { _hotScore: number; _finalScore: number },
): BoardThreadRow {
  // Rest-omit is how the three keys get dropped. The bindings are deliberate
  // discards, which this ESLint config reports because it does not set
  // `ignoreRestSiblings` — that option exists precisely for this pattern.
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
  const { hasMedia: _hasMedia, _hotScore: _hotScore, _finalScore: _finalScore, ...rest } = row;
  return rest;
}

export interface BoardThreads {
  threads: BoardThreadRow[];
  total: number;
  totalPages: number;
  /** threadId → the requesting user's vote value. Empty for anonymous readers. */
  voteMap: Map<string, number>;
}

export async function loadBoardThreads(opts: {
  boardId: string;
  page: number;
  sort?: string;
  userId?: string;
}): Promise<BoardThreads> {
  const { boardId, page, sort, userId } = opts;
  const threadWhere = { boardId, ...visibleArticleWhere(userId) };
  const total = await prisma.article.count({ where: threadWhere });

  let threads: BoardThreadRow[];

  if (sort === "latest") {
    threads = await prisma.article.findMany({
      where: threadWhere,
      orderBy: { lastRepliedAt: "desc" as const },
      skip: (page - 1) * ITEMS_PER_PAGE,
      take: ITEMS_PER_PAGE,
      select: BOARD_THREAD_SELECT,
    });
  } else {
    // Hot ranking: fetch all, score, then paginate
    const all = await prisma.article.findMany({
      where: threadWhere,
      take: 100,
      select: BOARD_THREAD_SELECT,
    });
    // Fetch pinned posts separately (may be outside the recent 100)
    const pinnedRows = await prisma.article.findMany({
      where: { ...threadWhere, hotOverride: "pinned" },
      select: BOARD_THREAD_SELECT,
    });
    const pinnedIds = new Set(pinnedRows.map((t) => t.id));
    const manualPinned = pinnedRows
      .concat(all.filter((t) => pinnedIds.has(t.id)))
      .filter((t, i, arr) => arr.findIndex((b) => b.id === t.id) === i)
      .sort((a, b) => (b.hotSortOrder || 0) - (a.hotSortOrder || 0));
    const eligible = all.filter((t) => !t.hotOverride);

    // The clock is read once here and injected, rather than twice inside the
    // ranking function: `scoreThread`'s `now` and the personalization `bucket`
    // used to be two separate `Date.now()` calls that could straddle a
    // millisecond boundary and disagree about what day it is.
    const now = Date.now();

    const ranked = applyHotRank(
      eligible.map((t) => ({
        ...t,
        // R26：媒体判定必须走统一 helper（content ∪ images）。只看 content 正则会
        // 让茶记自动帖拿不到 1.3 的媒体加权 —— 它们有图，只是图不在 content 里。
        hasMedia: !!(
          t.videoUrl ||
          extractFeedImages({ content: t.content || "", images: t.images ?? null }).coverImage
        ),
      })),
      // The board page rotates personalization daily so a reader's board is
      // stable all day. The home feed uses an hour bucket instead — that is a
      // product difference between the two surfaces, not an inconsistency.
      { now, bucket: Math.floor(now / 86400000), sessionUserId: userId },
    ).map(toBoardRow);

    // Pinned posts lead by construction: they are prepended, not scored. They
    // used to be stamped `_hotScore: Infinity` to say the same thing, but
    // nothing sorts `merged`, so those values were decorative and only cost a
    // type assertion to produce.
    const merged: BoardThreadRow[] = [...manualPinned, ...ranked];
    const start = (page - 1) * ITEMS_PER_PAGE;
    threads = merged.slice(start, start + ITEMS_PER_PAGE);
  }

  const voteMap = new Map<string, number>();
  if (userId && threads.length > 0) {
    const votes = await prisma.vote.findMany({
      where: { userId, refId: { in: threads.map((t) => t.id) } },
      select: { refId: true, value: true },
    });
    votes.forEach((v) => voteMap.set(v.refId, v.value));
  }

  return { threads, total, totalPages: Math.ceil(total / ITEMS_PER_PAGE), voteMap };
}
