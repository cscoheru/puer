import { prisma } from "@/lib/prisma";
import { visibleArticleWhere } from "@/lib/article-visibility";
import { convertText } from "@/lib/s2t";
import { scoreThread, jitterSeed, jitterAmount, tierFactor } from "@/lib/hot-rank";

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
  status: string;
  content: string;
  coverImage?: string | null;
  images?: string[];
  videoUrl?: string | null;
  flair: string | null;
  board: { slug: string; name: string } | null;
  author: { id: string; username: string; avatar: string | null; level: number; followerCount: number; karma: number };
  initialVote: number;
}

/**
 * Converts the DB-sourced text of a feed article to traditional Chinese.
 *
 * This has to run on the server, and it has to run *before* the article crosses
 * into `ForumFeed`. That component is a client component, so the article is
 * serialized into the RSC payload and rendered as-is; `convertText` carries a
 * server-only guard (it pulls ~30 KB of opencc + cheerio) and therefore cannot
 * be reached from there. The two halves of the app meet at that boundary —
 * `t()` from the zhCNtoTW map works on either side, `convertText` works only on
 * the server — and an unconverted field crossing it fails silently: there is no
 * type error, the page just renders simplified text inside traditional chrome.
 * That is exactly how `/tw/forum` shipped with a simplified feed.
 *
 * Fields deliberately left alone:
 *   - `author.username` — an identifier, not prose. Converting it would break
 *     the link between the rendered name and the account.
 *   - `coverImage` / `images` / `videoUrl` — URLs.
 *   - `flair` — the flairs in `forum-constants.ts` are already keys in the
 *     zhCNtoTW map, so they are translated client-side via `_()`.
 */
export function toTraditionalFeed(articles: FeedArticleDTO[]): FeedArticleDTO[] {
  return articles.map((a) => ({
    ...a,
    title: convertText(a.title),
    content: convertText(a.content),
    board: a.board ? { ...a.board, name: convertText(a.board.name) } : a.board,
  }));
}

/** Board names for the feed's board filter — the same client-boundary rule as
 *  {@link toTraditionalFeed}. `slug` stays untouched: it is the URL. */
export function toTraditionalBoards<T extends { name: string }>(boards: T[]): T[] {
  return boards.map((b) => ({ ...b, name: convertText(b.name) }));
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
  status: true,
  content: true,
  // P2-R26：茶记自动帖图片存独立 images 字段（content 纯文字），select 必须带上
  images: true,
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
  images: string[] | null;
  videoUrl: string | null;
  flair: string | null;
  board: { slug: string; name: string } | null;
  author: { id: string; username: string; avatar: string | null; level: number; followerCount: number; karma: number };
} & Record<string, unknown>;

/**
 * P2-R26：feed 图片 = content 内联 <img> ∪ article.images 字段（去重保序）。
 * 茶记自动帖（tasting-draft）的图片在独立 images 字段、content 纯文字，
 * 旧逻辑只从 content 提取导致这类帖子在 feed 全部无图、无轮播、无封面。
 */
export function extractFeedImages(a: { content: string; images: string[] | null }): {
  coverImage: string | null;
  images: string[];
} {
  const inline = Array.from(a.content.matchAll(/<img[^>]+src="([^">]+)"/g)).map((m) => m[1]);
  const merged = [...inline, ...(a.images ?? [])].filter((u, i, arr) => arr.indexOf(u) === i);
  return { coverImage: merged[0] ?? null, images: merged };
}

/**
 * V1-R5：classics 帖子筛选 — 品鉴帖（auto-post 含图）/ 已互动跟进帖放行；
 * 孤儿跟进帖（classics + teaId + 0 回复 + 0 图片）排除，避免噪音刷屏。
 */
function passesClassicsFilter(a: ArticleRow): boolean {
  if (!a.board || a.board.slug !== "classics") return true;
  if (!a.teaId) return true; // classics 吧但无关联茶品（如吧务贴），放行
  if ((a.replyCount || 0) >= 1) return true; // 已互动跟进帖
  if (Array.isArray(a.images) && a.images.length > 0) return true; // auto-post 茶记
  if (/<img[^>]+src=/i.test(a.content || "")) return true; // 老帖 content 内联图
  return false;
}

/**
 * V1-R5 多样性保护：单页 feed 中 classics 帖占比 ≤ cap，超出移至末尾（仍在页内，仅视觉降权）。
 */
function applyClassicsCap(rows: ArticleRow[], cap = 0.3): ArticleRow[] {
  if (rows.length === 0) return rows;
  const isClassics = (a: ArticleRow) => a.board?.slug === "classics";
  const classicsCount = rows.filter(isClassics).length;
  const maxClassics = Math.max(1, Math.floor(rows.length * cap));
  if (classicsCount <= maxClassics) return rows;
  const classics = rows.filter(isClassics);
  const nonClassics = rows.filter((a) => !isClassics(a));
  return [...nonClassics, ...classics.slice(0, maxClassics), ...classics.slice(maxClassics)];
}

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
    status: ((a as { status?: string }).status as string) || "published",
    content: a.content.replace(/<[^>]*>/g, " ").replace(/\s+\n/g, "\n").slice(0, 500),
    ...extractFeedImages(a),
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

  // V1-R5 解除：classics 帖不再 SQL 层硬排除，全量抓取后做 post-filter。
  // V1-R24：作者本人待审帖放行（仅作者自己可见）保留不变。
  // 注：visibleArticleWhere 返回值自带 status/OR 键，嵌套条件必须走 AND 合并。
  const wherePublished = {
    boardId: { not: null },
    AND: [
      {
        OR: [
          visibleArticleWhere(opts.userId ?? undefined),
          ...(opts.userId ? [{ status: "pending_review" as const, authorId: opts.userId }] : []),
        ],
      },
    ],
  };

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
    rows = (fetched.filter(passesClassicsFilter) as ArticleRow[]).slice(0, limit);
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
    // V1-R5：post-filter 排除孤儿跟进帖（classics + 0 回复 + 无图）
    raw = raw.filter(passesClassicsFilter);
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
      // P2-R26：封面含 article.images fallback（茶记帖 content 无内联图）
      _coverImage: extractFeedImages(a).coverImage,
    }));

    const minEngage = tab === "day" ? 1 : Math.max(2, Math.round(totalPosts / 20));
    // P2-R24 新帖冷启动（一）：发布 48h 内免互动门槛——新帖没有 upvotes/回复，
    // 原门槛（≥2 互动）会把它们整个挡在热榜外，用户发完帖翻遍 feed 也看不到。
    const FRESH_HOURS = 48;
    const freshCut = Date.now() - FRESH_HOURS * 3600_000;
    const filtered = enriched.filter((a) => {
      if (new Date(a.createdAt).getTime() >= freshCut) return true; // 新帖宽限期
      const netScore = Math.max(0, (a.upvotes || 0) - (a.downvotes || 0));
      const totalEngage = netScore + (a.replyCount || 0);
      const hasMedia = !!(a.videoUrl || a._coverImage);
      return hasMedia ? totalEngage >= 1 : totalEngage >= minEngage;
    });

    const paged = await hotRankAndPage({ filtered, manualPinned, wherePublished, offset, limit, userId: opts.userId });
    rows = paged.rows;
    hasMore = paged.hasMore;
  }

  return { articles: await toDTO(applyClassicsCap(rows), opts.userId), hasMore };
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

  // The scoring formula lives in `@/lib/hot-rank` so the board page and this
  // feed cannot drift apart when a weight is tuned. What is *not* shared is the
  // pipeline around it — cold-start, author diversity and the opportunity boost
  // below are v4.0 feed behaviour the board page does not have.
  const scored = filtered.map((a) => {
    // `_coverImage` is not on the declared row shape — it was resolved upstream by
    // `extractFeedImages`, so it arrives via the `Record<string, unknown>` index
    // signature and is `unknown` here. `videoUrl` is declared, hence no cast.
    const { videoUrl, _coverImage } = a;
    return {
      ...a,
      _hotScore: scoreThread(
        {
          id: a.id,
          upvotes: a.upvotes || 0,
          downvotes: a.downvotes || 0,
          replyCount: a.replyCount || 0,
          viewCount: a.viewCount || 0,
          // Same media question the board page asks, and for the same R26
          // reason: `_coverImage` was resolved by `extractFeedImages` upstream
          // (content ∪ images), never by regex on `content`.
          hasMedia: !!(videoUrl || _coverImage),
          createdAt: a.createdAt,
          lastRepliedAt: a.lastRepliedAt,
        },
        now,
      ),
    };
  });

  // P2-R24 新帖冷启动（二）：48h 内新帖给「榜首基准 × 时间衰减」的冷启动分——
  // 发布即刻 ≈ 榜首水平（热榜前部高曝光），线性衰减 48h 归零；期间若攒到真实
  // 互动则取两者较大值留存，无人关注则 48h 后被互动门槛过滤、自然沉底被超越。
  const FRESH_HOURS = 48;
  const freshCut = now - FRESH_HOURS * 3600_000;
  const topScore = scored.reduce((m, a) => Math.max(m, (a._hotScore as number) || 0), 0);
  for (const a of scored) {
    const createdMs = new Date(a.createdAt).getTime();
    if (createdMs >= freshCut) {
      const freshFactor = 1 - (now - createdMs) / (FRESH_HOURS * 3600_000); // 1 → 0
      const coldStart = topScore * 0.98 * freshFactor;
      if (coldStart > ((a._hotScore as number) || 0)) a._hotScore = coldStart;
    }
  }

  scored.sort((a, b) => (b._hotScore as number) - (a._hotScore as number));

  // Personalization seed: user ID (if logged in) + an hour bucket —
  // each user sees a different ordering, and the same user sees it reshuffle
  // every hour. V1-1.5 分层轮转：bucket 取小时粒度（版块页是天粒度，那边一整天
  // 稳定），配合 tierFactor 三层权重让 top 5 稳、中段抖、尾段重排。
  // `now` rather than a fresh `Date.now()`: the bucket has to agree with the
  // clock that scored the rows, or the two can straddle a boundary.
  const seed = jitterSeed(userId ?? undefined, Math.floor(now / 3600000));

  const jitterMap = new Map<string, number>();
  for (const a of scored) {
    jitterMap.set(a.id, jitterAmount(a.id, seed));
  }

  const topN = Math.min(5, scored.length);
  const ranked = scored
    .map((a, i) => ({
      ...a,
      // The tier is read off the `_hotScore` rank (`i` here), never off the
      // jittered rank — see `tierFactor`.
      _finalScore: a._hotScore * (1 + (jitterMap.get(a.id) || 0) * tierFactor(i, topN)),
    }))
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

  // 归档续读公共查询（窗口耗尽/不足时按 createdAt 倒序返回更早帖子；排除
  // 置顶避免与首屏重复；hotOverride 多为 NULL，须显式包含，`<> 'pinned'`
  // 会滤掉 NULL；跨请求 id 重复由客户端去重兜底）。注意 wherePublished
  // 自带 AND（跟进帖排除），此处必须合并进同一数组，直接写 AND 键会覆盖丢失。
  const archiveWhere = {
    ...wherePublished,
    AND: [
      ...((wherePublished.AND as object[]) || []),
      { OR: [{ hotOverride: null }, { hotOverride: { not: "pinned" } }] },
    ],
  };
  const fetchArchive = async (skip: number, take: number) =>
    prisma.article
      .findMany({
        where: archiveWhere,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        select: articleSelect,
      })
      .then((rows) => rows.filter(passesClassicsFilter));

  if (offset < combined.length) {
    // P2-R19：热榜窗口不足一页时自动「归档续读」填满 limit。周/日窗口帖量
    // 少时首屏只有 2-3 条（如 week 仅 3 帖达标），头部长期是同样几张老帖，
    // 已读降权形同虚设——没有未读帖可以顶上；补满后客户端始终有足量内容
    // 可供未读优先重排。窗口内帖可能同时落在归档头部（createdAt 倒序），
    // 服务端按 id 去重，避免 SSR 首屏出现重复 key。
    const windowRows = combined.slice(offset, offset + limit);
    let rows = windowRows;
    let hasMore = offset + limit < combined.length;
    if (windowRows.length < limit) {
      const windowIds = new Set(windowRows.map((a) => a.id));
      const need = limit - windowRows.length;
      const archive = await fetchArchive(0, need + 1);
      const fresh = (archive.filter((a) => !windowIds.has(a.id)) as unknown as ArticleRow[]).slice(0, need);
      rows = [...windowRows, ...fresh];
      // 归档拿满 need+1 才说明池子还有剩余（fresh 去重后可能少一条，用原始取数判断）
      hasMore = archive.length > need;
    }
    return { rows, hasMore };
  }
  const skip = offset - combined.length;
  const archive = await fetchArchive(skip, limit);
  return { rows: archive as unknown as ArticleRow[], hasMore: archive.length === limit };
}
