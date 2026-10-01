import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { convertText } from "@/lib/s2t";
import { t, twHref } from "@/i18n/translations";
import type { Locale } from "@/i18n/translations";
import { resolveRequestLocale } from "@/lib/locale-server";

export const dynamic = "force-dynamic";

const NAV_ITEMS = [
  { href: "/forum", label: "首页", icon: "🏠" },
  { href: "/forum/explore", label: "探索社区", icon: "🔍" },
  { href: "/forum/communities/new", label: "新建社区", icon: "➕" },
];

type SidebarTea = {
  id: string;
  name: string;
  tastingNoteCount: number;
  lastActiveAt: Date;
  thumb: string | null;
};

/** P2-R8 侧栏热点茶品：按最近品鉴/跟进时间动态排序，热度计数兜底补足 */
async function loadHotClassicTeas(take = 5): Promise<SidebarTea[]> {
  const [recentNotes, recentArticles] = await Promise.all([
    // 最近品鉴笔记（经典茶），每茶取最新一条时间
    prisma.tastingNote
      .groupBy({
        by: ["teaId"],
        where: { tea: { isClassic: true } },
        _max: { createdAt: true },
        orderBy: { _max: { createdAt: "desc" } },
        take: 12,
      })
      .catch(() => [] as { teaId: string; _max: { createdAt: Date | null } }[]),
    // 最近跟进帖（经典茶），每茶取最新一条时间
    prisma.article
      .groupBy({
        by: ["teaId"],
        where: { teaId: { not: null }, tea: { isClassic: true } },
        _max: { createdAt: true },
        orderBy: { _max: { createdAt: "desc" } },
        take: 12,
      })
      .catch(() => [] as { teaId: string | null; _max: { createdAt: Date | null } }[]),
  ]);

  // 合并两种活动信号 → 每茶最近活动时间
  const activity = new Map<string, Date>();
  for (const row of [...recentNotes, ...recentArticles]) {
    if (!row.teaId || !row._max.createdAt) continue;
    const prev = activity.get(row.teaId);
    if (!prev || row._max.createdAt > prev) activity.set(row.teaId, row._max.createdAt);
  }
  const dynamicIds = [...activity.entries()]
    .sort((a, b) => b[1].getTime() - a[1].getTime())
    .slice(0, take)
    .map(([id]) => id);

  // 动态茶不足时按品鉴数热度补足
  let ids = dynamicIds;
  if (ids.length < take) {
    const fill = await prisma.tea
      .findMany({
        where: { isClassic: true, id: { notIn: ids } },
        orderBy: { tastingNoteCount: "desc" },
        take: take - ids.length,
        select: { id: true },
      })
      .catch(() => [] as { id: string }[]);
    ids = [...ids, ...fill.map((t) => t.id)];
  }
  if (ids.length === 0) return [];

  const teas = await prisma.tea
    .findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        tastingNoteCount: true,
        coverImage: true,
        gallery: true,
        tastingNotes: { select: { images: true }, orderBy: { createdAt: "desc" }, take: 1 },
      },
    })
    .catch(() => []);

  // 保持活动时间排序；缩略图三级链（封面 → 图库 → 茶记图）
  return teas
    .map((t) => {
      const gallery = Array.isArray(t.gallery) ? (t.gallery as unknown[]).find((u) => typeof u === "string") : undefined;
      const noteImg = Array.isArray(t.tastingNotes[0]?.images)
        ? (t.tastingNotes[0]!.images as unknown[]).find((u) => typeof u === "string")
        : undefined;
      return {
        id: t.id,
        name: t.name,
        tastingNoteCount: t.tastingNoteCount,
        lastActiveAt: activity.get(t.id) ?? new Date(0), // 无活动记录（热度补足的）排后
        thumb: t.coverImage || (gallery as string | undefined) || (noteImg as string | undefined) || null,
      };
    })
    .sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());
}

export default async function ForumSidebar({ locale: forcedLocale }: { locale?: Locale } = {}) {
  // No prop means "whatever this request is in", not "simplified". Defaulting
  // to a constant made the sidebar the one part of the page that ignored the
  // reader's language: on a simplified URL with a zh-TW cookie the header and
  // the feed rendered traditional while the sidebar stayed simplified.
  const locale: Locale = forcedLocale ?? (await resolveRequestLocale());
  // Two different jobs, two different tools:
  //  - UI chrome ("社区", "发布新帖") goes through the zhCNtoTW map, the same
  //    table the client components use, so the sidebar and the header can
  //    never drift apart.
  //  - Board names, tea names and post titles come out of the database in
  //    simplified and are not in that map, so they need the real s2tw
  //    dictionary. Safe here because this is a server component — convertText
  //    is marked `server-only`.
  const tr = (key: string) => t(key, locale);
  const cv = (s: string) => (locale === "zh-TW" ? convertText(s) : s);

  let session: { user?: { id?: string } } | null = null;
  try { session = await auth(); } catch {}
  let boards: Array<{ id: string; name: string; slug: string; icon: string | null; threadCount: number }> = [];
  let hotClassicTeas: SidebarTea[] = [];
  let recentClassicPosts: Array<{ id: string; title: string; replyCount: number; createdAt: Date }> = [];
  try {
    [boards, hotClassicTeas, recentClassicPosts] = await Promise.all([
      prisma.board.findMany({
        orderBy: { sortOrder: "asc" },
        select: { id: true, name: true, slug: true, icon: true, threadCount: true },
      }),
      loadHotClassicTeas(12),
      // V1：最近 2 条 classics 帖 — 让侧栏入口不只是茶品目录，还能直接进帖子
      (async () => {
        const board = await prisma.board.findUnique({ where: { slug: "classics" }, select: { id: true } }).catch(() => null);
        if (!board) return [];
        return prisma.article.findMany({
          where: { boardId: board.id, status: "published" },
          orderBy: { createdAt: "desc" },
          take: 2,
          select: { id: true, title: true, replyCount: true, createdAt: true },
        });
      })(),
    ]);
  } catch {}

  return (
    <aside className="w-56 lg:w-64 shrink-0 hidden lg:block">
      <div className="sticky top-20 space-y-3">
        {/* 导航 */}
        <nav className="bg-white border border-stone-200 rounded-lg p-2">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={twHref(locale, item.href)}
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100 hover:text-stone-800 transition"
            >
              <span className="text-base">{item.icon}</span>
              <span className="font-medium">{tr(item.label)}</span>
            </Link>
          ))}
          {session?.user && (
            <Link
              href={twHref(locale, "/forum/new")}
              className="flex items-center gap-2.5 px-3 py-2 mt-1 rounded-lg text-sm font-medium bg-amber-800 text-white hover:bg-amber-900 transition"
            >
              <span className="text-base">✏️</span>
              <span>{tr("发布新帖")}</span>
            </Link>
          )}
        </nav>

        {/* 经典普洱 — 热点茶品动态榜（P2-R8：按最近品鉴/跟进排序；标题/更多进吧，茶品行进档案页） */}
        <div className="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-lg overflow-hidden hover:border-amber-400 transition">
          <Link
            href={twHref(locale, "/forum/classics")}
            className="flex items-center gap-2.5 p-3 pb-2 group"
          >
            <span className="text-xl shrink-0">🏵️</span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-amber-900 group-hover:text-amber-800 transition">
                {tr("经典普洱")}
              </div>
              <div className="text-[0.6875rem] text-stone-500 truncate">{tr("热点茶品 · 动态更新")}</div>
            </div>
            <span className="text-[0.6875rem] text-amber-700 group-hover:text-amber-600 shrink-0">更多›</span>
          </Link>
          {hotClassicTeas.length > 0 && (
            <div className="px-1.5 pb-1.5 space-y-0.5 max-h-72 overflow-y-auto overscroll-contain">
              {hotClassicTeas.map((tea, i) => (
                <Link
                  key={tea.id}
                  href={`/tea/${tea.id}`}
                  className="flex items-center gap-2 px-1.5 py-1.5 rounded-lg hover:bg-amber-100/60 transition group/tea"
                  title={cv(tea.name)}
                >
                  <span className={`w-4 text-center text-[0.6875rem] font-bold tabular-nums shrink-0 ${i < 3 ? "text-amber-700" : "text-stone-300"}`}>
                    {i + 1}
                  </span>
                  {tea.thumb ? (
                    <img src={tea.thumb} alt="" width={28} height={28} loading="lazy" decoding="async" className="w-7 h-7 rounded object-cover shrink-0 border border-amber-200/60" />
                  ) : (
                    <span className="w-7 h-7 rounded bg-white/70 border border-amber-200/60 shrink-0 flex items-center justify-center text-sm">🍵</span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-stone-700 truncate group-hover/tea:text-amber-800 transition leading-tight">
                      {cv(tea.name)}
                    </p>
                    <p className="text-[0.625rem] text-stone-400 leading-tight">
                      {tea.tastingNoteCount > 0 ? `${tea.tastingNoteCount} ${tr("篇品鉴")}` : tr("建档中")}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          )}
          {/* V1：最近 2 条 classics 帖 — 让侧栏入口不只是茶品目录，还能直接进帖子 */}
          {recentClassicPosts.length > 0 && (
            <div className="px-2 pb-2 pt-1 border-t border-amber-200/60 space-y-0.5">
              <p className="text-[0.625rem] font-semibold text-amber-800 uppercase tracking-wider px-0.5 mb-0.5">
                {tr("💬 最近经典帖")}
              </p>
              {recentClassicPosts.map((p) => (
                <Link
                  key={p.id}
                  href={twHref(locale, `/forum/thread/${p.id}`)}
                  className="block px-1.5 py-1 rounded text-xs text-stone-700 hover:bg-amber-100/60 hover:text-amber-800 transition leading-snug line-clamp-2"
                  title={cv(p.title)}
                >
                  {cv(p.title)}
                  {p.replyCount > 0 && (
                    <span className="ml-1 text-[0.625rem] text-stone-400">💬 {p.replyCount}</span>
                  )}
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* 社区 — 版块列表 */}
        <div className="bg-white border border-stone-200 rounded-lg p-3">
          <h2 className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-2 px-1">
            {tr("社区")}
          </h2>
          <div className="space-y-0.5">
            {boards.map((board) => (
              <Link
                key={board.id}
                href={twHref(locale, `/forum/${board.slug}`)}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-stone-600 hover:bg-stone-100 hover:text-stone-800 transition"
              >
                <span className="text-base shrink-0">{board.icon || "📄"}</span>
                <span className="truncate">{cv(board.name)}</span>
                {board.threadCount > 0 && (
                  <span className="ml-auto text-[0.625rem] text-stone-400">{board.threadCount}</span>
                )}
              </Link>
            ))}
          </div>
        </div>

        {/* 资源 */}
        <div className="bg-white border border-stone-200 rounded-lg p-3">
          <div className="space-y-0.5">
            <Link href="/about" className="block px-2 py-1.5 rounded-lg text-sm text-stone-600 hover:bg-stone-100 hover:text-stone-800 transition">
              {tr("关于 PuEr")}
            </Link>
            <Link href="/advertise" className="block px-2 py-1.5 rounded-lg text-sm text-stone-600 hover:bg-stone-100 hover:text-stone-800 transition">
              {tr("广告合作")}
            </Link>
            <Link href="/help" className="block px-2 py-1.5 rounded-lg text-sm text-stone-600 hover:bg-stone-100 hover:text-stone-800 transition">
              {tr("帮助")}
            </Link>
          </div>
        </div>

        {/* 规则与条款 */}
        <div className="px-3 space-y-1">
          <Link href="/rules" className="block text-xs text-stone-400 hover:text-stone-600 transition">
            {tr("社区规则")}
          </Link>
          <Link href="/privacy" className="block text-xs text-stone-400 hover:text-stone-600 transition">
            {tr("隐私政策")}
          </Link>
          <Link href="/terms" className="block text-xs text-stone-400 hover:text-stone-600 transition">
            {tr("用户协议")}
          </Link>
        </div>
      </div>
    </aside>
  );
}
