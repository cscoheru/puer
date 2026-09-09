import { prisma } from "@/lib/prisma";
import { visibleArticleWhere } from "@/lib/article-visibility";

/**
 * 论坛 feed 共享数据层（P2-R3 移动端懒加载）。
 *
 * 首屏（page.tsx 服务端渲染）与后续分页（/api/forum/feed）共用同一套
 * v4 热榜窗口算法（day/week/month）+ latest/essence 直查，保证排序一致。
 *
 * 热榜 tab 窗口内容耗尽后自动进入"归档续读"：按 createdAt 倒序返回更早
 * 的帖子（排除置顶，客户端按 id 去重），让移动端无限下滑始终有内容。
 */

export interface FeedArticleDTO {
  id: string;
  title: string;
  upvotes: number;
  downvotes: number;
  replyCount: number;
  createdAt: string;
  isEssence: boolean;
  isPinned: boolean;
  content: string;
  coverImage?: string | null;
  images?: string[];
  videoUrl?: string | null;
  flair: string | null;
  board: { slug: string; name: string } | null;
  author: { id: string; username: string; avatar: string | null; level: number; followerCount: number; karma: number };
  initialVote: number;
}

const articleSelect = {
  id: true,
  title: true,
  upvotes: true,
  downvotes: true,
  replyCount: true,
  viewCount: true,
  lastRepliedAt: true,
  createdAt: true,
  isEssence: true,
  isPinned: true,
  content: true,
  videoUrl: true,
  flair: true,
  hotOverride: true,
  hotSortOrder: true,
  board: { select: { slug: true, name: true } },
  author: { select: { id: true, username: true, avatar: true, level: true, followerCount: true, karma: true } },
} as const;

type ArticleRow = {
  id: string;
  title: string;
  upvotes: number;
  downvotes: number;
  replyCount: number;
  createdAt: Date;
  isEssence: boolean;
  isPinned: boolean;
  content: string;
  videoUrl: string | null;
  flair: string | null;
  board: { slug: string; name: string } | null;
  author: { id: string; username: string; avatar: string | null; level: number; followerCount: number; karma: number };
} & Record<string, unknown>;

async function toDTO(rows: ArticleRow[], userId?: string | null): Promise<FeedArticleDTO[]> {
  const voteMap = new Map<string, number>();
  if (userId && rows.length > 0) {
    const votes = await prisma.vote.findMany({
      where: { userId, refId: { in: rows.map((a) => a.id) } },
      select: { refId: true, value: true },
    });
    votes.forEach((v) => voteMap.set(v.refId, v.value));
  }
  return rows.map((a) => ({
    id: a.id,
    title: a.title,
    upvotes: a.upvotes,
    downvotes: a.downvotes,
    replyCount: a.replyCount,
    createdAt: a.createdAt.toISOString(),
    isEssence: a.isEssence,
    isPinned: a.isPinned,
    content: a.content.replace(/<[^>]*>/g, " ").replace(/\s+\n/g, "\n").slice(0, 500),
    coverImage: a.content.match(/<img[^>]+src="([^">]+)"/)?.[1] || null,
    images: Array.from(a.content.matchAll(/<img[^>]+src="([^">]+)"/g)).map((m) => m[1]),
    videoUrl: a.videoUrl,
    flair: a.flair,
    board: a.board,
    author: a.author,
    initialVote: voteMap.get(a.id) || 0,
  }));
}

export async function fetchForumFeed(opts: {
  tab: string;
  userId?: string | null;
  offset?: number;
  limit?: number;
}): Promise<{ articles: FeedArticleDTO[]; hasMore: boolean }> {
  // tab 归一化（与 forum/page.tsx 一致，legacy hot → week）
  const VALID_TABS = ["day", "week", "month", "latest", "essence"] as const;
  let tab = opts.tab || "week";
  if (tab === "hot") tab = "week";
  if (!(VALID_TABS as readonly string[]).includes(tab)) tab = "week";

  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.max(1, Math.min(300, Math.floor(opts.limit ?? 60)));

  const wherePublished = { ...visibleArticleWhere(opts.userId ?? undefined), boardId: { not: null } };

  let rows: ArticleRow[];
  let hasMore = false;

  if (tab === "essence" || tab === "latest") {
    const fetched = await prisma.article.findMany({
      where: tab === "essence" ? { ...wherePublished, isEssence: true } : wherePublished,
      orderBy: tab === "essence" ? { essencedAt: "desc" as const } : { updatedAt: "desc" as const },
      skip: offset,
      take: limit + 1,
      select: articleSelect,
    });
    hasMore = fetched.length > limit;
    rows = fetched.slice(0, limit) as unknown as ArticleRow[];
  } else {
    // ── v4 windowed hot ranking（与 forum/page.tsx 原实现一致）────────
    const WINDOW_HOURS: Record<string, number> = { day: 24, week: 168, month: 720 };
    const withRevival = tab === "week";

    const fetchWindow = (hours: number) =>
      prisma.article.findMany({
        where: {
          ...wherePublished,
          ...(withRevival
            ? {
                OR: [
                  { createdAt: { gte: new Date(Date.now() - hours * 3600_000) } },
                  { lastRepliedAt: { gte: new Date(Date.now() - hours * 3600_000) } },
                ],
              }
            : { createdAt: { gte: new Date(Date.now() - hours * 3600_000) } }),
        },
        orderBy: { createdAt: "desc" },
        take: 300,
        select: articleSelect,
      });

    let raw = await fetchWindow(WINDOW_HOURS[tab]);
    if (tab === "day") {
      for (const h of [48, 72]) {
        if (raw.filter((a) => !a.hotOverride).length >= 8) break;
        raw = await fetchWindow(h);
      }
    }

    const pinnedRows = await prisma.article.findMany({
      where: { ...wherePublished, hotOverride: "pinned" },
      select: articleSelect,
    });
    const pinnedIds = new Set(pinnedRows.map((a) => a.id));
    const manualPinned = pinnedRows
      .concat(raw.filter((a) => pinnedIds.has(a.id)))
      .filter((a, i, arr) => arr.findIndex((b) => b.id === a.id) === i)
      .sort((a, b) => (b.hotSortOrder || 0) - (a.hotSortOrder || 0));
    const eligible = raw.filter((a) => !a.hotOverride);

    const totalPosts = eligible.length;
    const enriched = eligible.map((a) => ({
      ...a,
      _coverImage: a.content.match(/<img[^>]+src="([^">]+)"/)?.[1] || null,
    }));

    const minEngage = tab === "day" ? 1 : Math.max(2, Math.round(totalPosts / 20));
    const filtered = enriched.filter((a) => {
      const netScore = Math.max(0, (a.upvotes || 0) - (a.downvotes || 0));
      const totalEngage = netScore + (a.replyCount || 0);
      const hasMedia = !!(a.videoUrl || a._coverImage);
      return hasMedia ? totalEngage >= 1 : totalEngage >= minEngage;
    });

    const paged = await hotRankAndPage({ filtered, manualPinned, wherePublished, offset, limit, userId: opts.userId });
    rows = paged.rows;
    hasMore = paged.hasMore;
  }

  return { articles: await toDTO(rows, opts.userId), hasMore };
}

/** v4 热榜打分 + 分页 + 归档续读（day/week/month tab 专用） */
async function hotRankAndPage(opts: {
  filtered: (Record<string, unknown> & {
    id: string; upvotes: number; downvotes: number; replyCount: number;
    viewCount: number; createdAt: Date; lastRepliedAt: Date | null;
    videoUrl: string | null; content: string; author: { id: string };
  })[];
  manualPinned: Record<string, unknown>[];
  wherePublished: Record<string, unknown>;
  offset: number;
  limit: number;
  userId?: string | null;
}): Promise<{ rows: ArticleRow[]; hasMore: boolean }> {
  const { filtered, manualPinned, wherePublished, offset, limit, userId } = opts;
  const now = Date.now();

  const scored = filtered.map((a) => {
    const net = Math.max(0, (a.upvotes || 0) - (a.downvotes || 0));
    const score = Math.log1p(net) * 6 + Math.log1p(a.replyCount || 0) * 4 + Math.log1p(Math.min((a.viewCount as number) || 0, 1000)) * 0.2;
    const boost = (a as { videoUrl?: string | null; _coverImage?: string | null }).videoUrl || (a as { _coverImage?: string | null })._coverImage ? 1.3 : 1;
    const age = Math.min((now - new Date(a.lastRepliedAt || a.createdAt).getTime()) / 3600000, 720);
    const timeBonus = 1 + 0.3 / (1 + age / 48);
    return { ...a, _hotScore: score * boost * timeBonus };
  });

  scored.sort((a, b) => (b._hotScore as number) - (a._hotScore as number));

  // Personalization seed: user ID (if logged in) + current date —
  // each user sees a different ordering, same user sees it stable within a day
  const dayBucket = Math.floor(Date.now() / 86400000);
  const seedStr = (userId || "anon") + ":" + dayBucket;
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) { seed = ((seed << 5) - seed) + seedStr.charCodeAt(i); seed |= 0; }
  seed = Math.abs(seed);

  const jitterMap = new Map<string, number>();
  for (const a of scored) {
    let h = seed;
    for (let i = 0; i < a.id.length; i++) { h = ((h << 5) - h) + a.id.charCodeAt(i); h |= 0; }
    jitterMap.set(a.id, Math.abs(h) % 41 / 100);
  }

  const topN = Math.min(5, scored.length);
  const ranked = scored
    .map((a, i) => {
      const tierFactor = i < topN ? 1.0 : i < topN + 10 ? 0.6 : 0.3;
      const jitter = 1 + (jitterMap.get(a.id) || 0) * tierFactor;
      return { ...a, _finalScore: (a._hotScore as number) * jitter };
    })
    .sort((a, b) => (b._finalScore as number) - (a._finalScore as number))
    // Diversity filter: max 3 posts per author
    .filter((() => {
      const count = new Map<string, number>();
      return (a: { author: { id: string } }) => {
        const c = count.get(a.author.id) || 0;
        if (c >= 3) return false;
        count.set(a.author.id, c + 1);
        return true;
      };
    })());

  // Opportunity boost: 2 posts from positions 15-50 pushed into top 10
  if (ranked.length > 20) {
    const rangeStart = Math.min(15, ranked.length - 5);
    const rangeEnd = Math.min(50, ranked.length);
    const range = rangeEnd - rangeStart;
    const pick1 = rangeStart + (Math.abs(seed * 7 + 13) % range);
    let pick2 = rangeStart + (Math.abs(seed * 13 + 7 + pick1) % (range - 1));
    if (pick2 >= pick1) pick2++;
    const top10Score = ranked[Math.min(9, ranked.length - 1)]._finalScore as number;
    if (pick1 < ranked.length && (ranked[pick1]._finalScore as number) < top10Score * 0.8) {
      (ranked[pick1] as { _finalScore: number })._finalScore = top10Score * (1.05 + (seed % 10) / 100);
    }
    if (pick2 < ranked.length && (ranked[pick2]._finalScore as number) < top10Score * 0.8) {
      (ranked[pick2] as { _finalScore: number })._finalScore = top10Score * (1.05 + (seed * 3 % 10) / 100);
    }
    ranked.sort((a, b) => (b._finalScore as number) - (a._finalScore as number));
  }

  const combined = [...manualPinned, ...ranked] as unknown as ArticleRow[];

  if (offset < combined.length) {
    return {
      rows: combined.slice(offset, offset + limit),
      hasMore: offset + limit < combined.length,
    };
  }
  // 归档续读：窗口耗尽后按 createdAt 倒序返回更早帖子（排除置顶避免与
  // 首屏重复；hotOverride 多为 NULL，须显式包含，`<> 'pinned'` 会滤掉 NULL；
  // 跨请求 id 重复由客户端去重兜底）
  const skip = offset - combined.length;
  const archive = await prisma.article.findMany({
    where: {
      ...wherePublished,
      AND: [{ OR: [{ hotOverride: null }, { hotOverride: { not: "pinned" } }] }],
    },
    orderBy: { createdAt: "desc" },
    skip,
    take: limit,
    select: articleSelect,
  });
  return { rows: archive as unknown as ArticleRow[], hasMore: archive.length === limit };
}
