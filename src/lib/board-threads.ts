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

export function applyHotRank<T extends {
  id: string; upvotes: number; downvotes: number; replyCount: number;
  viewCount: number; videoUrl: string | null; content: string;
  images: string[] | null;
  createdAt: Date; lastRepliedAt: Date | null;
}>(
  threads: T[],
  sessionUserId?: string,
): (T & { _hotScore: number; _finalScore: number })[] {
  const now = Date.now();
  const scored = threads.map((t) => {
    const net = Math.max(0, t.upvotes - t.downvotes);
    // R26：媒体判定必须走统一 helper（content ∪ images）。只看 content 正则会
    // 让茶记自动帖拿不到 1.3 的媒体加权 —— 它们有图，只是图不在 content 里。
    const { coverImage } = extractFeedImages({ content: t.content || "", images: t.images ?? null });
    const score = Math.log1p(net) * 6 + Math.log1p(t.replyCount) * 4 + Math.log1p(Math.min(t.viewCount, 1000)) * 0.2;
    const boost = (t.videoUrl || coverImage) ? 1.3 : 1;
    const age = Math.min((now - new Date(t.lastRepliedAt || t.createdAt).getTime()) / 3600000, 720);
    const timeBonus = 1 + 0.3 / (1 + age / 48);
    // `coverImage` is only an input to the media boost below — it is not
    // returned. Carrying it as `_coverImage` on every row put a string nobody
    // read into the payload that crosses into the client components.
    return { ...t, _hotScore: score * boost * timeBonus };
  });

  scored.sort((a, b) => b._hotScore - a._hotScore);

  // Per-user personalization jitter
  const dayBucket = Math.floor(Date.now() / 86400000);
  const seedStr = (sessionUserId || "anon") + ":" + dayBucket;
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) { seed = ((seed << 5) - seed) + seedStr.charCodeAt(i); seed |= 0; }
  seed = Math.abs(seed);

  const topN = Math.min(5, scored.length);
  return scored
    .map((a, i) => {
      let h = seed;
      for (let j = 0; j < a.id.length; j++) { h = ((h << 5) - h) + a.id.charCodeAt(j); h |= 0; }
      const jitter = 1 + (Math.abs(h) % 41) / 100 * (i < topN ? 1.0 : i < topN + 10 ? 0.6 : 0.3);
      return { ...a, _finalScore: a._hotScore * jitter };
    })
    .sort((a, b) => b._finalScore - a._finalScore);
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
    const ranked = applyHotRank(eligible, userId);
    const merged = [
      ...manualPinned.map((t) => ({ ...t, _hotScore: Infinity, _finalScore: Infinity } as typeof ranked[0])),
      ...ranked,
    ];
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
