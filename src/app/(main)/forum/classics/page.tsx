import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import ForumSidebar from "@/components/forum-sidebar";
import BrandCard from "@/components/tea/classic/brand-card";
import ClassicTeaCard from "@/components/tea/classic/classic-tea-card";
import { teaListSelect } from "@/lib/tea-query";
import { extractFeedImages } from "@/lib/forum-feed-server";
import { normalizeTeaSort, teaSortHref, type TeaSort } from "@/lib/tea-heat";
import { rankTeasForPage } from "@/lib/tea-heat-server";
import { canPromoteToClassic } from "@/lib/tea-permissions";
import { visibleTeaWhere } from "@/lib/tea-tier";
import { visibleArticleWhere } from "@/lib/article-visibility";

export const metadata = {
  title: "经典普洱 · 品牌吧 - 大益吧/下关吧/福今吧",
  description:
    "经典普洱品牌吧：按品牌分吧的经典茶品档案与转化跟进。大益吧、下关吧、福今吧、今大福吧、黎明吧、兴海吧，每个吧展示该品牌经典茶品（热度 / 最近更新 / 品鉴最多三种排序），茶友可持续发布跟进帖。",
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

type BarConfig = { key: string; label: string; icon: string | null; logo: string | null; brands: string[] };

async function loadBars(): Promise<BarConfig[]> {
  const bars = await prisma.brandBar
    .findMany({ orderBy: { sortOrder: "asc" }, select: { key: true, label: true, icon: true, logo: true, brands: true } })
    .catch(() => []);
  if (bars.length > 0) return bars;
  return DEFAULT_BARS.map((b) => ({ key: b.key, label: b.label, icon: b.icon, logo: null, brands: [...b.brands] }));
}

/** 渲染上限（排序之后截断 —— 先排再截，顺序才由排序说了算）。 */
const RENDER_LIMIT = 120;

export default async function ClassicsPage({
  searchParams,
}: {
  searchParams: Promise<{ bar?: string; type?: string; q?: string; sort?: string }>;
}) {
  const params = await searchParams;
  const session = await auth();
  const barKey = params.bar || "all";
  const type = params.type || "";
  const search = params.q || "";
  const sort = normalizeTeaSort(params.sort);
  const bars = await loadBars();
  const knownBrands: string[] = bars.flatMap((b) => [...b.brands]);
  const bar = bars.find((b) => b.key === barKey) || null;

  // 「经典 = 站长认可」：`needsReview` 的条目是还没被站长整理过的素材，
  // 不该出现在经典普洱区。2026-11-02 收口 —— 此前这里不按 needsReview 过滤，
  // 用户自建的茶（越权口子放进去的）会直接公开出现在经典区。
  const where: Record<string, unknown> = {
    isClassic: true,
    deletedAt: null,
    ...visibleTeaWhere(),
  };
  if (barKey === "other") where.brand = { notIn: knownBrands };
  else if (bar) where.brand = { in: [...bar.brands] };
  if (type) where.type = type;
  if (search) where.name = { contains: search, mode: "insensitive" } as const;

  // 并行查询：经典分组 + 全品牌分组 + 品牌品鉴数 + 主列表 + 最近活动流
  //
  // ⚠️ 主列表**不再** `take: 120` 后再排热度 —— 那等于「先按品鉴数取前 120，
  // 再在这 120 里换顺序」，品鉴少的茶再热也上不来（站长 2026-11-02 报的
  // 「一直都是按品鉴数量倒序」就是这个）。现在取全量、按选定的口径排完再截断。
  const [classicGrouped, allGrouped, brandNoteSums, teas, totalCount, recentArticles, classicsBoard] = await Promise.all([
    prisma.tea.groupBy({ by: ["brand"], where: { isClassic: true, deletedAt: null, ...visibleTeaWhere() }, _count: { _all: true } }).catch(() => []),
    prisma.tea.groupBy({ by: ["brand"], where: { deletedAt: null }, _count: { _all: true } }).catch(() => []),
    prisma.tea.groupBy({
      by: ["brand"],
      where: { deletedAt: null },
      _sum: { tastingNoteCount: true },
    }).catch(() => []),
    prisma.tea.findMany({ where, orderBy: [{ tastingNoteCount: "desc" }, { year: "desc" }], select: teaListSelect }).catch(() => []),
    prisma.tea.count({ where }).catch(() => 0),
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

  // 第二轮：排序（热度输入的聚合 + 排序口径）与茶友跟进（依赖当前筛选出的茶品 id）
  const teaIds = teas.map((t) => t.id);
  const [sortedTeas, followUps] = await Promise.all([
    rankTeasForPage(teas, sort, session?.user?.id),
    loadFollowUps(teaIds, session?.user?.id),
  ]);

  const classicCount = new Map(classicGrouped.map((g) => [g.brand, g._count._all]));
  const allCount = new Map(allGrouped.map((g) => [g.brand, g._count._all]));
  const noteCount = new Map(brandNoteSums.map((g) => [g.brand, g._sum.tastingNoteCount || 0]));
  const countForBar = (brands: string[]) => brands.reduce((sum, b) => sum + (classicCount.get(b) || 0), 0);
  const allCountForBar = (brands: string[]) => brands.reduce((sum, b) => sum + (allCount.get(b) || 0), 0);
  const noteCountForBar = (brands: string[]) => brands.reduce((sum, b) => sum + (noteCount.get(b) || 0), 0);
  const otherCount = countForBar([...knownBrands]) === 0 ? 0 : classicGrouped.reduce((s, g) => s + g._count._all, 0) - countForBar([...knownBrands]);
  const otherAllCount = allGrouped.reduce((s, g) => s + g._count._all, 0) - allCountForBar([...knownBrands]);
  const otherNoteCount = brandNoteSums.reduce((s, g) => s + (g._sum.tastingNoteCount || 0), 0) - noteCountForBar([...knownBrands]);
  const totalClassic = classicGrouped.reduce((s, g) => s + g._count._all, 0);

  // 热度排序带**读者级 + 每小时轮转**的抖动（与首页 feed 同一套口径），
  // 所以每次点进来顺序会变 —— 这是站长明确要的（「每次点击进去后都是一样」）。
  const rankedTeas = sortedTeas.slice(0, RENDER_LIMIT);

  const barLabel = bar ? bar.label : barKey === "other" ? "其他吧" : "全部茶品";
  const sortLabel = sort === "updated" ? "按最近更新排序" : sort === "notes" ? "按品鉴数量排序" : "按热度排序";
  const barDesc = bar
    ? `${bar.label}收录的经典茶品（${sortLabel}），点击查看品种档案与转化跟进`
    : barKey === "other"
      ? `六大厂牌之外的经典茶品合集（${sortLabel}）`
      : `全部经典茶品（${sortLabel}）`;

  const pillHref = (key: string) => `/forum/classics${key === "all" ? "" : `?bar=${key}`}`;
  const sortBase = { bar: barKey, type, q: search };

  return (
    <div className="flex gap-4 md:gap-6 px-2 md:px-4 max-w-screen-2xl mx-auto py-4">
      <ForumSidebar />
      <div className="flex-1 min-w-0">
        {/* Page header */}
        <div className="flex items-center gap-2.5 mb-3 px-1 flex-wrap">
          <span className="text-2xl shrink-0">🏵️</span>
          <h1 className="text-lg md:text-xl font-serif font-bold text-amber-900">
            经典普洱 <span className="text-stone-400 font-normal text-sm">· 共 {totalClassic} 款</span>
          </h1>
          {canPromoteToClassic(session?.user) && (
            <Link
              href="/encyclopedia/new?classic=1"
              className="ml-auto px-3 py-1.5 text-xs md:text-sm rounded-lg bg-amber-800 text-white hover:bg-amber-900 transition font-medium"
            >
              ✨ 发布新经典
            </Link>
          )}
        </div>

        {/* 品牌卡片横排 */}
        <div className="flex gap-3 overflow-x-auto pb-3 mb-4 snap-x snap-mandatory -mx-1 px-1">
          <BrandCard
            label="全部"
            icon="🏵️"
            href={pillHref("all")}
            classicCount={totalClassic}
            totalCount={allGrouped.reduce((s, g) => s + g._count._all, 0)}
            noteCount={brandNoteSums.reduce((s, g) => s + (g._sum.tastingNoteCount || 0), 0)}
            active={barKey === "all" && !bar}
          />
          {bars.map((b) => (
            <BrandCard
              key={b.key}
              label={b.label}
              icon={b.icon}
              logo={b.logo}
              href={pillHref(b.key)}
              classicCount={countForBar([...b.brands])}
              totalCount={allCountForBar([...b.brands])}
              noteCount={noteCountForBar([...b.brands])}
              active={b.key === barKey}
            />
          ))}
          <BrandCard
            label="其他吧"
            icon="📦"
            href={pillHref("other")}
            classicCount={otherCount}
            totalCount={otherAllCount}
            noteCount={otherNoteCount}
            active={barKey === "other"}
          />
        </div>

        <div className="flex gap-4">
          {/* 主区：当前吧的茶品列表 */}
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
              <div>
                <h2 className="text-base font-serif font-bold text-stone-800">{barLabel}</h2>
                <p className="text-xs text-stone-400 mt-0.5">
                  {barDesc} · 共 {totalCount} 款{totalCount > RENDER_LIMIT ? `（显示前 ${RENDER_LIMIT}）` : ""}
                </p>
              </div>
              <form method="GET" className="flex flex-wrap gap-2">
                {barKey !== "all" && <input type="hidden" name="bar" value={barKey} />}
                {sort !== "heat" && <input type="hidden" name="sort" value={sort} />}
                <select name="type" defaultValue={type} className="px-2.5 py-1.5 border border-stone-300 rounded-lg text-xs bg-white">
                  <option value="">生熟不限</option>
                  <option value="raw">生茶</option>
                  <option value="ripe">熟茶</option>
                </select>
                <input name="q" type="text" placeholder="搜索茶品..." defaultValue={search} className="flex-1 min-w-0 sm:w-44 sm:flex-none px-2.5 py-1.5 border border-stone-300 rounded-lg text-xs" />
                <button type="submit" className="px-3 py-1.5 bg-amber-800 text-white rounded-lg text-xs font-medium hover:bg-amber-900 transition">筛选</button>
              </form>
            </div>

            {/* 排序切换 */}
            <div className="mb-3">
              <SortTabs current={sort} base={sortBase} />
            </div>

            {rankedTeas.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {rankedTeas.map((tea) => (
                  <ClassicTeaCard key={tea.id} tea={tea} />
                ))}
              </div>
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

            {/* 茶友跟进 —— 普通用户唯一能参与经典普洱的方式。
                放在主区底部而不是只放右栏：右栏「最近活动」在手机端是隐藏的
                （hidden lg:block），手机用户 otherwise 完全看不到社区在聊什么。 */}
            <FollowUpList posts={followUps} />
          </div>

          {/* 右栏：最近活动流 */}
          <RecentActivityPanel articles={recentArticles} boardId={classicsBoard?.id} />
        </div>
      </div>
    </div>
  );
}

/**
 * 排序切换。
 *
 * 用 Link 而不是 GET 表单的下拉：排序是**浏览口径**，不是筛选条件 ——
 * 品牌吧 pills 与生熟/搜索是筛选，排序是口径，两者不该混在一个表单里。
 */
function SortTabs({
  current,
  base,
}: {
  current: TeaSort;
  base: { bar?: string; type?: string; q?: string };
}) {
  const items: Array<{ key: TeaSort; label: string }> = [
    { key: "heat", label: "🔥 热度" },
    { key: "updated", label: "🕐 最近更新" },
    { key: "notes", label: "📚 品鉴最多" },
  ];
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-stone-400 mr-1">排序</span>
      {items.map((it) => {
        const active = it.key === current;
        return (
          <Link
            key={it.key}
            href={teaSortHref(it.key, base)}
            scroll={false}
            className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition ${
              active
                ? "bg-amber-800 text-white border-amber-800"
                : "bg-white text-stone-600 border-stone-300 hover:border-amber-400 hover:text-amber-800"
            }`}
          >
            {it.label}
          </Link>
        );
      })}
    </div>
  );
}

interface FollowUpPost {
  id: string;
  title: string;
  replyCount: number;
  upvotes: number;
  createdAt: Date;
  tea: { id: string; name: string; brand: string } | null;
  author: { username: string } | null;
}

/**
 * 茶友跟进帖（经典普洱区）。
 *
 * 只收 `origin = "human"`：auto-post 管线产出的 AI 帖**也带 teaId**
 * （`scripts/auto-post.mjs` 的日志里就打印 `d.teaId`），不过滤的话 AI 帖会
 * 混进「茶友跟进」，而 AI 文章按 PRD 永远不进数据层。
 */
async function loadFollowUps(teaIds: string[], userId?: string): Promise<FollowUpPost[]> {
  if (teaIds.length === 0) return [];
  return prisma.article
    .findMany({
      where: {
        ...visibleArticleWhere(userId),
        teaId: { in: teaIds },
        origin: "human",
      },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        title: true,
        replyCount: true,
        upvotes: true,
        createdAt: true,
        tea: { select: { id: true, name: true, brand: true } },
        author: { select: { username: true } },
      },
    })
    .catch(() => []);
}

/** 底部「茶友跟进」列表。 */
function FollowUpList({ posts }: { posts: FollowUpPost[] }) {
  return (
    <section className="mt-8">
      <h2 className="text-base font-serif font-bold text-stone-800 mb-1">💬 茶友跟进</h2>
      <p className="text-xs text-stone-400 mb-3">
        茶友为这些经典茶写的跟进帖 —— 转化观察、行情、开汤记录
      </p>
      <div className="bg-white border border-stone-200 rounded-lg divide-y divide-stone-100">
        {posts.length === 0 ? (
          <p className="px-4 py-8 text-center text-stone-400 text-sm">
            还没有跟进帖 —— 在任意经典茶的档案页可以发第一篇
          </p>
        ) : (
          posts.map((p) => (
            <Link
              key={p.id}
              href={`/forum/thread/${p.id}`}
              className="flex items-center gap-3 px-3 py-2.5 hover:bg-amber-50/50 transition group"
            >
              <span className="w-9 h-9 rounded bg-stone-100 shrink-0 flex items-center justify-center text-base">
                {p.tea ? "🍵" : "💬"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-stone-700 truncate group-hover:text-amber-800 transition">
                  {p.title}
                </span>
                <span className="flex items-center gap-2 mt-0.5 text-[0.625rem] text-stone-400">
                  {p.tea && <span className="truncate">{p.tea.name}</span>}
                  <span>{p.author?.username ?? "匿名"}</span>
                  <span>{new Date(p.createdAt).toLocaleDateString("zh-CN")}</span>
                </span>
              </span>
              <span className="shrink-0 text-[0.625rem] text-stone-400 flex items-center gap-2">
                {p.replyCount > 0 && <span>💬 {p.replyCount}</span>}
                {p.upvotes > 0 && <span>▲ {p.upvotes}</span>}
              </span>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}

/** 右栏最近活动流：classics 吧最新 20 帖，每条卡片链接到帖子详情。 */
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
                const isTastingDraft = !a.teaId && a.images && a.images.length > 0;
                return (
                  <Link
                    key={a.id}
                    href={`/forum/thread/${a.id}`}
                    className="flex gap-2 p-2.5 hover:bg-amber-50/50 transition group"
                  >
                    {coverImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
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
