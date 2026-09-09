import { prisma } from "@/lib/prisma";
import Link from "next/link";
import type { Metadata } from "next";
import ForumSidebar from "@/components/forum-sidebar";
import LatestPosts from "@/components/latest-posts";
import { parseMarket } from "@/lib/market-info";

export const metadata: Metadata = {
  title: "经典普洱 · 品牌吧 - 大益吧/下关吧/福今吧",
  description:
    "经典普洱品牌吧：按品牌分吧的经典茶品档案与转化跟进。大益吧、下关吧、福今吧、今大福吧、黎明吧、兴海吧，每个吧展示该品牌经典茶品（按热度排序），茶友可持续发布跟进帖。",
  keywords: ["经典普洱", "品牌吧", "大益吧", "下关吧", "福今吧", "今大福", "7542", "88青"],
  alternates: { canonical: "/forum/classics" },
};

export const dynamic = "force-dynamic";

/** 品牌吧（贴吧式）：六大主力厂牌独立成吧，其余品牌归入其他吧 */
const BARS = [
  { key: "dayi", label: "大益吧", icon: "🏷️", brands: ["大益"] },
  { key: "xiaguan", label: "下关吧", icon: "🏔️", brands: ["下关"] },
  { key: "fujin", label: "福今吧", icon: "🍃", brands: ["福今"] },
  { key: "jindafu", label: "今大福吧", icon: "🧧", brands: ["今大福"] },
  { key: "liming", label: "黎明吧", icon: "🌅", brands: ["黎明"] },
  { key: "xinghai", label: "兴海吧", icon: "🌊", brands: ["兴海"] },
] as const;
const KNOWN_BRANDS: string[] = BARS.flatMap((b) => [...b.brands]);

/** 茶品热度：品鉴数为主 + 评分加权 + 行情快照/跟进帖加成 */
function heatScore(t: {
  tastingNoteCount: number;
  avgRating: number | null;
  marketInfo: unknown;
  _count?: { articles: number };
}) {
  return (
    t.tastingNoteCount * 10 +
    (t.avgRating ?? 0) * 2 +
    (t.marketInfo ? 3 : 0) +
    (t._count?.articles || 0)
  );
}

const teaSelect = {
  id: true,
  name: true,
  brand: true,
  year: true,
  batch: true,
  type: true,
  coverImage: true,
  avgRating: true,
  tastingNoteCount: true,
  marketInfo: true,
  updatedAt: true,
  _count: { select: { articles: true } },
} as const;

export default async function ClassicsPage({
  searchParams,
}: {
  searchParams: Promise<{ bar?: string; type?: string; q?: string }>;
}) {
  const params = await searchParams;
  const barKey = params.bar || "all";
  const type = params.type || "";
  const search = params.q || "";
  const bar = BARS.find((b) => b.key === barKey) || null;

  const where: Record<string, unknown> = { isClassic: true };
  if (barKey === "other") where.brand = { notIn: KNOWN_BRANDS };
  else if (bar) where.brand = { in: [...bar.brands] };
  if (type) where.type = type;
  if (search) where.name = { contains: search, mode: "insensitive" } as const;

  // 各吧茶品数 + 热门池（左侧widget）+ 近期有品鉴更新的茶（用于"更新中"标记）
  const [grouped, hotPool, recentNotes] = await Promise.all([
    prisma.tea.groupBy({ by: ["brand"], where: { isClassic: true }, _count: { _all: true } }).catch(() => []),
    prisma.tea.findMany({ where: { isClassic: true }, orderBy: { tastingNoteCount: "desc" }, take: 60, select: teaSelect }).catch(() => []),
    prisma.tastingNote.findMany({ orderBy: { createdAt: "desc" }, take: 40, distinct: ["teaId"], select: { teaId: true, createdAt: true } }).catch(() => []),
  ]);

  const brandCount = new Map(grouped.map((g) => [g.brand, g._count._all]));
  const countForBar = (brands: string[]) => brands.reduce((sum, b) => sum + (brandCount.get(b) || 0), 0);
  const otherCount = countForBar([...KNOWN_BRANDS]) === 0 ? 0 : grouped.reduce((s, g) => s + g._count._all, 0) - countForBar([...KNOWN_BRANDS]);
  const totalClassic = grouped.reduce((s, g) => s + g._count._all, 0);

  const recentIds = new Set(
    // 服务端组件中读取时钟属于正常行为；react-hooks/purity 规则误报
    // eslint-disable-next-line react-hooks/purity
    recentNotes.filter((n) => Date.now() - new Date(n.createdAt).getTime() < 30 * 86400_000).map((n) => n.teaId),
  );
  const hotTeas = [...hotPool].sort((a, b) => heatScore(b) - heatScore(a)).slice(0, 10);

  const [teas, totalCount] = await Promise.all([
    prisma.tea.findMany({ where, orderBy: [{ tastingNoteCount: "desc" }, { year: "desc" }], take: 120, select: teaSelect }).catch(() => []),
    prisma.tea.count({ where }).catch(() => 0),
  ]);
  teas.sort((a, b) => heatScore(b) - heatScore(a));

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
        {/* Page header */}
        <div className="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-lg p-4 md:p-5 mb-4">
          <div className="flex items-center gap-2.5 mb-1.5 flex-wrap">
            <span className="text-2xl">🏵️</span>
            <h1 className="text-xl md:text-2xl font-serif font-bold text-amber-900">经典普洱 · 品牌吧</h1>
            <Link
              href="/forum/new?board=classics"
              className="ml-auto px-3 py-1.5 text-xs md:text-sm rounded-lg bg-amber-800 text-white hover:bg-amber-900 transition font-medium"
            >
              ✏️ 发布跟进帖
            </Link>
          </div>
          <p className="text-xs md:text-sm text-stone-600 leading-relaxed">
            按品牌分吧的经典茶品档案与转化跟进（共 {totalClassic} 款）：品种档案、历年品鉴转化档案、东和行情快照与茶友跟进讨论。进入茶品页即可发布跟进帖更新近况。
          </p>
        </div>

        {/* 吧导航（横向滚动 pills） */}
        <div className="flex gap-2 overflow-x-auto pb-2 mb-4 -mx-1 px-1">
          {[
            { key: "all", label: `全部 ${totalClassic}` },
            ...BARS.map((b) => ({ key: b.key as string, label: `${b.label} ${countForBar([...b.brands])}` })),
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
          {/* 左侧：热门茶品 widget（桌面显示；≤10 款，最近更新打绿点） */}
          <HotTeasWidget teas={hotTeas} recentIds={recentIds} />

          {/* 主区：当前吧的茶品列表（热度排序） */}
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
              <div>
                <h2 className="text-lg font-serif font-bold text-stone-800">{barLabel}</h2>
                <p className="text-xs text-stone-400 mt-0.5">{barDesc} · 共 {totalCount} 款{totalCount > 120 ? "（显示前 120）" : ""}</p>
              </div>
              <form method="GET" className="flex gap-2">
                {barKey !== "all" && <input type="hidden" name="bar" value={barKey} />}
                <select name="type" defaultValue={type} className="px-2.5 py-1.5 border border-stone-300 rounded-lg text-xs bg-white">
                  <option value="">生熟不限</option>
                  <option value="raw">生茶</option>
                  <option value="ripe">熟茶</option>
                </select>
                <input name="q" type="text" placeholder="搜索茶品..." defaultValue={search} className="w-32 md:w-44 px-2.5 py-1.5 border border-stone-300 rounded-lg text-xs" />
                <button type="submit" className="px-3 py-1.5 bg-amber-800 text-white rounded-lg text-xs font-medium hover:bg-amber-900 transition">筛选</button>
              </form>
            </div>

            {teas.length > 0 ? (
              <TeaList teas={teas} recentIds={recentIds} />
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
        </div>
      </div>
      <LatestPosts />
    </div>
  );
}

type ClassicTeaRow = {
  id: string;
  name: string;
  brand: string;
  year: number;
  batch: string | null;
  type: string;
  coverImage: string | null;
  avgRating: number | null;
  tastingNoteCount: number;
  marketInfo: unknown;
  _count: { articles: number };
};

/** 左侧热门茶品 widget：≤10 款，按热度排序，近 30 天有新品鉴的打绿点 */
function HotTeasWidget({ teas, recentIds }: { teas: ClassicTeaRow[]; recentIds: Set<string> }) {
  return (
    <aside className="w-60 shrink-0 hidden lg:block">
      <div className="sticky top-20 space-y-3">
        <div className="bg-white border border-stone-200 rounded-lg p-3">
          <h3 className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-2 px-1">
            🔥 热门茶品 · 最近更新
          </h3>
          <div className="space-y-1">
            {teas.map((t, i) => {
              const market = parseMarket(t.marketInfo);
              return (
                <Link
                  key={t.id}
                  href={`/tea/${t.id}`}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-amber-50 transition group"
                >
                  <span className={`w-5 text-center text-xs font-bold tabular-nums ${i < 3 ? "text-amber-700" : "text-stone-300"}`}>
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-stone-700 truncate group-hover:text-amber-800 transition">
                      {recentIds.has(t.id) && (
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 mr-1 align-middle" title="近30天有新品鉴" />
                      )}
                      {t.name}
                    </p>
                    <p className="text-[10px] text-stone-400">
                      {t.tastingNoteCount > 0 ? `${t.tastingNoteCount} 篇品鉴` : "建档中"}
                      {market?.price && ` · ${market.price}`}
                    </p>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
        <div className="bg-white border border-stone-200 rounded-lg p-3 text-xs text-stone-500 leading-relaxed">
          <p className="font-medium text-stone-600 mb-1">如何在吧里跟进？</p>
          <p>点击茶品进入档案页，顶部「发布跟进帖」即可为该茶添加近况（转化观察、行情见闻、开汤记录）。档案创建者与茶友均可更新。</p>
        </div>
      </div>
    </aside>
  );
}

/** 吧内茶品列表行：封面缩略 + 档案信息 + 行情价，热度已排序 */
function TeaList({ teas, recentIds }: { teas: ClassicTeaRow[]; recentIds: Set<string> }) {
  return (
    <div className="space-y-2">
      {teas.map((tea) => {
        const market = parseMarket(tea.marketInfo);
        return (
          <Link
            key={tea.id}
            href={`/tea/${tea.id}`}
            className="flex items-center gap-3 p-3 bg-white rounded-xl border border-stone-200 hover:border-amber-300 hover:shadow-sm transition group"
          >
            <div className="w-14 h-14 rounded-lg overflow-hidden bg-gradient-to-br from-amber-50 to-stone-100 shrink-0">
              {tea.coverImage ? (
                <img src={tea.coverImage} alt={tea.name} loading="lazy" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-2xl">🍵</div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-medium text-stone-800 text-sm truncate group-hover:text-amber-800 transition">
                  {tea.name}
                </h3>
                {recentIds.has(tea.id) && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full">更新中</span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                <span className="text-[10px] px-1.5 py-0.5 bg-stone-100 text-stone-500 rounded">{tea.brand}</span>
                <span className="text-[10px] px-1.5 py-0.5 bg-stone-100 text-stone-500 rounded">
                  {tea.year}{tea.batch ? `-${tea.batch}` : ""}
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${tea.type === "raw" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                  {tea.type === "raw" ? "生" : "熟"}
                </span>
              </div>
              <p className="text-xs text-stone-400 mt-1.5">
                {tea.tastingNoteCount > 0 ? `${tea.tastingNoteCount} 篇品鉴` : "建档中"}
                {tea.avgRating != null && ` · ★${tea.avgRating.toFixed(1)}`}
                {tea._count.articles > 0 && ` · ${tea._count.articles} 条跟进`}
              </p>
            </div>
            <div className="shrink-0 text-right hidden sm:block">
              {market ? (
                <>
                  <p className="text-sm font-semibold text-amber-800">{market.price}</p>
                  <p className="text-[10px] text-stone-300 mt-0.5">{market.source || "东和茶库"}</p>
                </>
              ) : (
                <p className="text-[10px] text-stone-300">暂无行情</p>
              )}
              <p className="text-[10px] text-amber-700 group-hover:translate-x-0.5 transition mt-1.5">查看档案 ›</p>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
