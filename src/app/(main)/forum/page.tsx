import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import type { Metadata } from "next";
import ForumFeed from "@/components/forum-feed";
import ForumSidebar from "@/components/forum-sidebar";
import LatestPosts from "@/components/latest-posts";
import { visibleArticleWhere } from "@/lib/article-visibility";

export const metadata: Metadata = {
  title: "普洱论坛 - 品茶交流社区",
  description: "普洱茶爱好者交流论坛。品茶心得分享、茶叶评测讨论、普洱茶知识问答。与万千茶友一起发现好茶。",
  keywords: ["普洱论坛", "品茶论坛", "茶友交流", "茶叶讨论", "普洱茶社区"],
  alternates: { canonical: "/forum" },
  openGraph: {
    title: "普洱论坛 - 品茶交流社区 | Puêr",
    description: "普洱茶爱好者交流论坛。品茶心得分享、茶叶评测讨论、普洱茶知识问答。",
  },
};

export const dynamic = "force-dynamic";

export default async function ForumPage(props: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const searchParams = await props.searchParams;
  // v4 hot ranking: windowed tabs (day/week/month) + latest/essence.
  // Legacy ?tab=hot maps to week (the new default).
  const VALID_TABS = ["day", "week", "month", "latest", "essence"] as const;
  let tab = searchParams.tab || "week";
  if (tab === "hot") tab = "week";
  if (!(VALID_TABS as readonly string[]).includes(tab)) tab = "week";
  const session = await auth();

  const boards = await prisma.board.findMany({
    orderBy: { sortOrder: "asc" },
  });

  // P2-R2/R3 经典普洱卡片：移动端推荐流穿插 + 经典普洱模块数据源
  const classicTeas = await prisma.tea
    .findMany({
      where: { isClassic: true },
      orderBy: [{ tastingNoteCount: "desc" }, { year: "desc" }],
      take: 20,
      select: {
        id: true,
        name: true,
        brand: true,
        year: true,
        type: true,
        coverImage: true,
        avgRating: true,
        tastingNoteCount: true,
      },
    })
    .catch(() => []);

  const wherePublished = { ...visibleArticleWhere(session?.user?.id), boardId: { not: null } };

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

  let articles;
  if (tab === "essence") {
    articles = await prisma.article.findMany({
      where: { ...wherePublished, isEssence: true },
      orderBy: { essencedAt: "desc" },
      take: 50,
      select: articleSelect,
    });
  } else if (tab === "latest") {
    // Sort by updatedAt desc so freshly published drafts (which keep their
    // original createdAt) appear at the top instead of being lost under
    // older posts with newer createdAt. take: 50 to match essence tab.
    articles = await prisma.article.findMany({
      where: wherePublished,
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: articleSelect,
    });
  } else {
    // ── v4 windowed hot ranking ────────────────────────────────────
    // day (24h, auto-expands to 48h/72h when too few) / week (7d,
    // posts with fresh replies are revived) / month (30d).
    // Scoring keeps the v3.0 quality-first formula; the time window
    // itself is what makes the list change every day.
    const windowTab = tab === "day" ? "day" : tab === "month" ? "month" : "week";
    const WINDOW_HOURS: Record<string, number> = { day: 24, week: 168, month: 720 };

    const fetchWindow = (hours: number, withRevival: boolean) =>
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

    let raw = await fetchWindow(WINDOW_HOURS[windowTab], windowTab === "week");
    if (windowTab === "day") {
      // Auto-expand the "today" window so the tab never looks empty
      for (const h of [48, 72]) {
        if (raw.filter((a) => !a.hotOverride).length >= 8) break;
        raw = await fetchWindow(h, false);
      }
    }

    {
      // Pinned posts first on every tab (may be outside the window)
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

      const now = Date.now();
      const totalPosts = eligible.length;

      const enriched = eligible.map((a) => ({
        ...a,
        _coverImage: a.content.match(/<img[^>]+src="([^">]+)"/)?.[1] || null,
      }));

      // Quality floor: basic engagement filter. Relaxed on the day tab —
      // freshness is the point there, not accumulated engagement.
      const minEngage = windowTab === "day" ? 1 : Math.max(2, Math.round(totalPosts / 20));
      const filtered = enriched.filter((a) => {
        const netScore = Math.max(0, (a.upvotes || 0) - (a.downvotes || 0));
        const totalEngage = netScore + (a.replyCount || 0);
        const hasMedia = !!(a.videoUrl || a._coverImage);
        return hasMedia ? totalEngage >= 1 : totalEngage >= minEngage;
      });

      // Compute base quality score for each post
      const scored = filtered.map((a) => {
        const net = Math.max(0, (a.upvotes || 0) - (a.downvotes || 0));
        const score = Math.log1p(net) * 6 + Math.log1p(a.replyCount || 0) * 4 + Math.log1p(Math.min((a.viewCount || 0), 1000)) * 0.2;
        const boost = (a.videoUrl || a._coverImage) ? 1.3 : 1;
        const age = Math.min((now - new Date(a.lastRepliedAt || a.createdAt).getTime()) / 3600000, 720);
        const timeBonus = 1 + 0.3 / (1 + age / 48);
        return { ...a, _hotScore: score * boost * timeBonus };
      });

      // Sort by raw score to get quality tiers
      scored.sort((a, b) => b._hotScore - a._hotScore);

      // Personalization seed: use user ID (if logged in) + current date
      // This ensures each logged-in user sees a different ordering,
      // and the same user sees different ordering day-to-day
      const dayBucket = Math.floor(Date.now() / 86400000); // changes daily
      const seedStr = (session?.user?.id || "anon") + ":" + dayBucket;
      let seed = 0;
      for (let i = 0; i < seedStr.length; i++) { seed = ((seed << 5) - seed) + seedStr.charCodeAt(i); seed |= 0; }
      seed = Math.abs(seed);

      // Per-post personalization jitter (different for each user)
      const jitterMap = new Map<string, number>();
      for (const a of scored) {
        let h = seed;
        for (let i = 0; i < a.id.length; i++) { h = ((h << 5) - h) + a.id.charCodeAt(i); h |= 0; }
        jitterMap.set(a.id, Math.abs(h) % 41 / 100); // 0-0.40 per-user jitter
      }

      // Apply jitter and re-sort
      const topN = Math.min(5, scored.length);
      let ranked = scored.map((a, i) => {
        const tierFactor = i < topN ? 1.0 : i < topN + 10 ? 0.6 : 0.3;
        const jitter = 1 + (jitterMap.get(a.id) || 0) * tierFactor;
        return { ...a, _finalScore: a._hotScore * jitter, _jitter: jitter };
      })
      .sort((a, b) => b._finalScore - a._finalScore)
      // Diversity filter
      .filter((() => {
        const count = new Map<string, number>();
        return (a) => {
          const c = count.get(a.author.id) || 0;
          if (c >= 3) return false;
          count.set(a.author.id, c + 1);
          return true;
        };
      })());

      // Opportunity boost: pick 2 posts from positions 15-50 and push them into top 10
      // This ensures undiscovered posts get a chance to be seen
      if (ranked.length > 20) {
        // Generate 2 random indices in the 15-50 range (deterministic per user)
        const rangeStart = Math.min(15, ranked.length - 5);
        const rangeEnd = Math.min(50, ranked.length);
        const range = rangeEnd - rangeStart;
        // First pick
        let pick1 = rangeStart + (Math.abs(seed * 7 + 13) % range);
        // Second pick from remaining
        let pick2 = rangeStart + (Math.abs(seed * 13 + 7 + pick1) % (range - 1));
        if (pick2 >= pick1) pick2++;
        // Boost their scores to break into top 10
        const top10Score = ranked[Math.min(9, ranked.length - 1)]._finalScore;
        if (pick1 < ranked.length && ranked[pick1]._finalScore < top10Score * 0.8) {
          ranked[pick1]._finalScore = top10Score * (1.05 + (seed % 10) / 100);
        }
        if (pick2 < ranked.length && ranked[pick2]._finalScore < top10Score * 0.8) {
          ranked[pick2]._finalScore = top10Score * (1.05 + (seed * 3 % 10) / 100);
        }
        // Re-sort
        ranked.sort((a, b) => b._finalScore - a._finalScore);
      }
      // Merge: manual pinned first, then algorithm-ranked
      const pinnedWithScores = manualPinned.map((a) => ({
        ...a,
        _coverImage: a.content.match(/<img[^>]+src="([^">]+)"/)?.[1] || null,
        _hotScore: Infinity,
        _finalScore: Infinity,
        _jitter: 1,
      }));
      articles = [...pinnedWithScores, ...ranked];
    }
  }

  let voteMap = new Map<string, number>();
  if (session?.user?.id && articles.length > 0) {
    const votes = await prisma.vote.findMany({
      where: {
        userId: session.user.id,
        refId: { in: articles.map((a) => a.id) },
      },
      select: { refId: true, value: true },
    });
    votes.forEach((v) => voteMap.set(v.refId, v.value));
  }

  const feedArticles = articles.map((a) => ({
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

  return (
    <div className="flex gap-4 md:gap-6 px-2 md:px-4 max-w-screen-2xl mx-auto">
      <ForumSidebar />
      <div className="flex-1 min-w-0">
        <ForumFeed
          articles={feedArticles}
          boards={boards.map((b) => ({ id: b.id, name: b.name, slug: b.slug, icon: b.icon }))}
          currentUserId={session?.user?.id}
          tab={tab}
          classics={classicTeas}
        />
      </div>
      <LatestPosts />
    </div>
  );
}
