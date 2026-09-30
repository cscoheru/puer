import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import ForumSidebar from "@/components/forum-sidebar";
import LatestPosts from "@/components/latest-posts";
import { TeaList } from "@/components/tea/tea-list";
import { sortByHeat, teaListSelect } from "@/lib/tea-query";
import { extractFeedImages } from "@/lib/forum-feed-server";

export const metadata = {
  title: "经典普洱 · 品牌吧 - 大益吧/下关吧/福今吧",
  description:
    "经典普洱品牌吧：按品牌分吧的经典茶品档案与转化跟进。大益吧、下关吧、福今吧、今大福吧、黎明吧、兴海吧，每个吧展示该品牌经典茶品（按热度排序），茶友可持续发布跟进帖。",
  keywords: ["经典普洱", "品牌吧", "大益吧", "下关吧", "福今吧", "今大福", "7542", "88青"],
  alternates: { canonical: "/forum/classics" },
};

export const dynamic = "force-dynamic";

/** 品牌吧（贴吧式）：配置存 DB（P2-R13，管理员可在 /admin/classics 编辑），
 *  读取失败或表空时回退到内置默认（六大主力厂牌），其余品牌归入其他吧 */
const DEFAULT_BARS = [
  { key: "dayi", label: "大益吧", icon: "🏷️", brands: ["大益"] },
  { key: "xiaguan", label: "下关吧", icon: "🏔️", brands: ["下关"] },
  { key: "fujin", label: "福今吧", icon: "🍃", brands: ["福今"] },
  { key: "jindafu", label: "今大福吧", icon: "🧧", brands: ["今大福"] },
  { key: "liming", label: "黎明吧", icon: "🌅", brands: ["黎明"] },
  { key: "xinghai", label: "兴海吧", icon: "🌊", brands: ["兴海"] },
] as const;

type BarConfig = { key: string; label: string; icon: string | null; brands: string[] };

async function loadBars(): Promise<BarConfig[]> {
  const bars = await prisma.brandBar
    .findMany({ orderBy: { sortOrder: "asc" }, select: { key: true, label: true, icon: true, brands: true } })
    .catch(() => []);
  if (bars.length > 0) return bars;
  return DEFAULT_BARS.map((b) => ({ key: b.key, label: b.label, icon: b.icon, brands: [...b.brands] }));
}

export default async function ClassicsPage({
  searchParams,
}: {
  searchParams: Promise<{ bar?: string; type?: string; q?: string }>;
}) {
  const params = await searchParams;
  const session = await auth(); // P2-R6：发布新经典按钮仅 Lv.2+
  const barKey = params.bar || "all";
  const type = params.type || "";
  const search = params.q || "";
  const bars = await loadBars();
  const knownBrands: string[] = bars.flatMap((b) => [...b.brands]);
  const bar = bars.find((b) => b.key === barKey) || null;

  const where: Record<string, unknown> = { isClassic: true, deletedAt: null };
  if (barKey === "other") where.brand = { notIn: knownBrands };
  else if (bar) where.brand = { in: [...bar.brands] };
  if (type) where.type = type;
  if (search) where.name = { contains: search, mode: "insensitive" } as const;

  // 并行查询：茶品分组 + 主列表 + 最近活动流
  const [grouped, teas, totalCount, recentArticles, classicsBoard] = await Promise.all([
    prisma.tea.groupBy({ by: ["brand"], where: { isClassic: true, deletedAt: null }, _count: { _all: true } }).catch(() => []),
    prisma.tea.findMany({ where, orderBy: [{ tastingNoteCount: "desc" }, { year: "desc" }], take: 120, select: teaListSelect }).catch(() => []),
    prisma.tea.count({ where }).catch(() => 0),
    // V1: 最近活动 = classics 吧最新 20 帖（含未互动的跟进帖——这里不是 feed，是档案目录的活动流）
    prisma.board
      .findUnique({ where: { slug: "classics" }, select: { id: true } })
      .then((b) =>
        b
          ? prisma.article.findMany({
              where: { boardId: b.id, status: "published" },
              orderBy: { createdAt: "desc" },
              take: 20,
              select: {
                id: true,
                title: true,
                upvotes: true,
                replyCount: true,
                createdAt: true,
                images: true,
                content: true,
                flair: true,
                teaId: true,
                tea: { select: { id: true, name: true, brand: true } },
                author: { select: { username: true } },
              },
            })
          : [],
      )
      .catch(() => [] as Array<{
        id: string;
        title: string;
        upvotes: number;
        replyCount: number;
        createdAt: Date;
        images: string[] | null;
        content: string;
        flair: string | null;
        teaId: string | null;
        tea: { id: string; name: string; brand: string } | null;
        author: { username: string };
      }>),
    prisma.board.findUnique({ where: { slug: "classics" }, select: { id: true } }).catch(() => null),
  ]);

  const brandCount = new Map(grouped.map((g) => [g.brand, g._count._all]));
  const countForBar = (brands: string[]) => brands.reduce((sum, b) => sum + (brandCount.get(b) || 0), 0);
  const otherCount = countForBar([...knownBrands]) === 0 ? 0 : grouped.reduce((s, g) => s + g._count._all, 0) - countForBar([...knownBrands]);
  const totalClassic = grouped.reduce((s, g) => s + g._count._all, 0);

  const rankedTeas = sortByHeat(teas);

  const barLabel = bar ? bar.label : barKey === "other" ? "其他吧" : "全部茶品";
  const barDesc = bar
    ? `${bar.label}收录的经典茶品（按热度排序），点击查看品种档案与转化跟进`
    : barKey === "other"
      ? "六大厂牌之外的经典茶品合集（按热度排序）"
      : "全部经典茶品（按热度排序）";

  const pillHref = (key: string) => `/forum/classics${key === "all" ? "" : `?bar=${key}`}`;

  return (
    <div className="flex gap-4 md:gap-6 px-2 md:px-4 max-w-screen-2xl mx-auto py-4">
      <ForumSidebar />
      <div className="flex-1 min-w-0">
        {/* Page header — V1 减肥为 1 行 */}
        <div className="flex items-center gap-2.5 mb-3 px-1 flex-wrap">
          <span className="text-2xl shrink-0">🏵️</span>
          <h1 className="text-lg md:text-xl font-serif font-bold text-amber-900">
            经典普洱 <span className="text-stone-400 font-normal text-sm">· 共 {totalClassic} 款</span>
          </h1>
          {/* P2-R6：「发布新经典」= 创建茶品档案并入选经典普洱吧（Lv.2+）；
              跟进帖入口在每个茶品档案页内（所有登录用户可发） */}
          {(session?.user?.level ?? 0) >= 2 && (
            <Link
              href="/encyclopedia/new?classic=1"
              className="ml-auto px-3 py-1.5 text-xs md:text-sm rounded-lg bg-amber-800 text-white hover:bg-amber-900 transition font-medium"
            >
              ✨ 发布新经典
            </Link>
          )}
        </div>

        {/* 吧导航（横向滚动 pills） */}
        <div className="flex gap-2 overflow-x-auto pb-2 mb-4 -mx-1 px-1">
          {[
            { key: "all", label: `全部 ${totalClassic}` },
            ...bars.map((b) => ({ key: b.key as string, label: `${b.label} ${countForBar([...b.brands])}` })),
            { key: "other", label: `其他吧 ${otherCount}` },
          ].map((p) => {
            const active = (p.key === "all" && !bar && barKey !== "other") || p.key === barKey;
            return (
              <Link
                key={p.key}
                href={pillHref(p.key)}
                className={`shrink-0 px-3.5 py-2 rounded-full text-sm font-medium border transition ${
                  active
                    ? "bg-amber-800 text-white border-amber-800"
                    : "bg-white text-stone-600 border-stone-200 hover:border-amber-300 hover:text-amber-800"
                }`}
              >
                {p.label}
              </Link>
            );
          })}
        </div>

        <div className="flex gap-4">
          {/* 主区：当前吧的茶品列表（热度排序） */}
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
              <div>
                <h2 className="text-base font-serif font-bold text-stone-800">{barLabel}</h2>
                <p className="text-xs text-stone-400 mt-0.5">
                  {barDesc} · 共 {totalCount} 款{totalCount > 120 ? "（显示前 120）" : ""}
                </p>
              </div>
              <form method="GET" className="flex flex-wrap gap-2">
                {barKey !== "all" && <input type="hidden" name="bar" value={barKey} />}
                <select name="type" defaultValue={type} className="px-2.5 py-1.5 border border-stone-300 rounded-lg text-xs bg-white">
                  <option value="">生熟不限</option>
                  <option value="raw">生茶</option>
                  <option value="ripe">熟茶</option>
                </select>
                <input name="q" type="text" placeholder="搜索茶品..." defaultValue={search} className="flex-1 min-w-0 sm:w-44 sm:flex-none px-2.5 py-1.5 border border-stone-300 rounded-lg text-xs" />
                <button type="submit" className="px-3 py-1.5 bg-amber-800 text-white rounded-lg text-xs font-medium hover:bg-amber-900 transition">筛选</button>
              </form>
            </div>

            {rankedTeas.length > 0 ? (
              <TeaList teas={rankedTeas} />
            ) : (
              <div className="text-center py-16 border border-dashed border-stone-200 rounded-lg bg-white">
                <p className="text-stone-300 text-lg mb-1">🏵️</p>
                <p className="text-stone-500 text-sm mb-3">
                  {type || search ? "没有符合条件的茶品，试试调整筛选" : "该吧还没有经典茶品收录"}
                </p>
                <Link href="/forum/classics" className="text-sm text-amber-800 hover:text-amber-900 font-medium">
                  ← 返回全部茶品
                </Link>
              </div>
            )}
          </div>

          {/* 右栏：最近活动流（桌面显示） */}
          <RecentActivityPanel articles={recentArticles} boardId={classicsBoard?.id} />
        </div>
      </div>
      <LatestPosts />
    </div>
  );
}

/** 右栏最近活动流：classics 吧最新 20 帖，每条卡片链接到帖子详情。
 *  桌面 lg+ 显示（≥1024px）；移动端隐藏避免与 LatestPosts 重复 */
function RecentActivityPanel({
  articles,
  boardId,
}: {
  articles: Array<{
    id: string;
    title: string;
    upvotes: number;
    replyCount: number;
    createdAt: Date;
    images: string[] | null;
    content: string;
    flair: string | null;
    teaId: string | null;
    tea: { id: string; name: string; brand: string } | null;
    author: { username: string };
  }>;
  boardId?: string;
}) {
  return (
    <aside className="w-72 shrink-0 hidden lg:block">
      <div className="sticky top-20">
        <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
          <div className="px-3 py-2.5 border-b border-stone-100 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-stone-700 flex items-center gap-1.5">
              <span>📌</span>
              <span>最近活动</span>
            </h3>
            {boardId && (
              <Link href={`/forum/classics`} className="text-[0.6875rem] text-amber-700 hover:text-amber-800">
                更多 ›
              </Link>
            )}
          </div>
          {articles.length === 0 ? (
            <div className="px-3 py-8 text-center text-stone-400 text-xs">暂无活动</div>
          ) : (
            <div className="divide-y divide-stone-100 max-h-[70vh] overflow-y-auto overscroll-contain">
              {articles.map((a) => {
                const { coverImage } = extractFeedImages({ content: a.content, images: a.images });
                const isTastingDraft = !a.teaId && a.images && a.images.length > 0; // 茶记自动帖
                return (
                  <Link
                    key={a.id}
                    href={`/forum/thread/${a.id}`}
                    className="flex gap-2 p-2.5 hover:bg-amber-50/50 transition group"
                  >
                    {coverImage ? (
                      <img
                        src={coverImage}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="w-12 h-12 rounded object-cover shrink-0 border border-stone-100"
                      />
                    ) : (
                      <span className="w-12 h-12 rounded bg-stone-100 shrink-0 flex items-center justify-center text-lg">
                        {isTastingDraft ? "📝" : a.teaId ? "💬" : "🍵"}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-stone-700 leading-snug line-clamp-2 group-hover:text-amber-800 transition">
                        {a.title}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5 text-[0.625rem] text-stone-400">
                        {a.tea && <span className="truncate">{a.tea.name}</span>}
                        {a.replyCount > 0 && <span>💬 {a.replyCount}</span>}
                        {a.upvotes > 0 && <span>▲ {a.upvotes}</span>}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}