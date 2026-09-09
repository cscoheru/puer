import { prisma } from "@/lib/prisma";
import Link from "next/link";
import type { Metadata } from "next";
import ForumSidebar from "@/components/forum-sidebar";
import LatestPosts from "@/components/latest-posts";
import { parseMarket } from "@/lib/market-info";

export const metadata: Metadata = {
  title: "经典普洱 - 品种档案与转化跟进",
  description:
    "普洱茶经典品种系统介绍与转化跟踪。历年品鉴档案、行情快照与茶友讨论，持续跟进每一款经典茶的陈化之路。",
  keywords: ["经典普洱", "普洱茶品种", "88青", "7542", "大白菜", "老茶", "普洱转化"],
  alternates: { canonical: "/forum/classics" },
};

export const dynamic = "force-dynamic";


export default async function ClassicsPage({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string; type?: string; q?: string }>;
}) {
  const params = await searchParams;
  const brand = params.brand || "";
  const type = params.type || "";
  const search = params.q || "";

  const where: Record<string, unknown> = { isClassic: true };
  if (brand) where.brand = brand;
  if (type) where.type = type;
  if (search) where.name = { contains: search, mode: "insensitive" } as const;

  const [teas, brandRows] = await Promise.all([
    prisma.tea
      .findMany({
        where,
        orderBy: [{ tastingNoteCount: "desc" }, { year: "desc" }, { name: "asc" }],
        take: 60,
      })
      .catch(() => []),
    prisma.tea
      .findMany({ where: { isClassic: true }, select: { brand: true }, distinct: ["brand"] })
      .then((rows) => rows.map((r) => r.brand))
      .catch(() => [] as string[]),
  ]);

  return (
    <div className="flex gap-4 md:gap-6 px-2 md:px-4 max-w-screen-2xl mx-auto py-4">
      <ForumSidebar />
      <div className="flex-1 min-w-0">
        {/* Page header */}
        <div className="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-lg p-4 md:p-5 mb-4">
          <div className="flex items-center gap-2.5 mb-1.5">
            <span className="text-2xl">🏵️</span>
            <h1 className="text-xl md:text-2xl font-serif font-bold text-amber-900">经典普洱</h1>
          </div>
          <p className="text-xs md:text-sm text-stone-600 leading-relaxed">
            系统介绍普洱茶经典品种，持续跟进转化与行情。每一款茶都有：品种档案、历年品鉴（转化档案）、东和行情快照与茶友跟进讨论。
          </p>
        </div>

        {/* Filters */}
        <form method="GET" className="flex flex-wrap gap-2 mb-4">
          <select
            name="brand"
            defaultValue={brand}
            className="px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/40"
          >
            <option value="">全部品牌</option>
            {brandRows.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          <select
            name="type"
            defaultValue={type}
            className="px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/40"
          >
            <option value="">生熟不限</option>
            <option value="raw">生茶</option>
            <option value="ripe">熟茶</option>
          </select>
          <input
            name="q"
            type="text"
            placeholder="搜索经典茶品..."
            defaultValue={search}
            className="flex-1 min-w-[160px] px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40"
          />
          <button
            type="submit"
            className="px-4 py-2 bg-stone-800 text-white rounded-lg text-sm hover:bg-stone-900 transition"
          >
            筛选
          </button>
        </form>

        {/* Grid */}
        {teas.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {teas.map((tea) => {
              const market = parseMarket(tea.marketInfo);
              return (
                <Link
                  key={tea.id}
                  href={`/tea/${tea.id}`}
                  className="block bg-white rounded-xl border border-stone-200 overflow-hidden hover:shadow-md hover:border-amber-300 transition group"
                >
                  {tea.coverImage ? (
                    <div className="aspect-[4/3] bg-stone-100">
                      <img src={tea.coverImage} alt={tea.name} loading="lazy" className="w-full h-full object-cover" />
                    </div>
                  ) : (
                    <div className="aspect-[4/3] bg-gradient-to-br from-amber-50 to-stone-100 flex items-center justify-center">
                      <span className="text-4xl">🍵</span>
                    </div>
                  )}
                  <div className="p-3">
                    <h3 className="font-medium text-stone-800 text-sm truncate group-hover:text-amber-800 transition">
                      {tea.name}
                    </h3>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      <span className="text-[10px] px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded">{tea.brand}</span>
                      <span className="text-[10px] px-1.5 py-0.5 bg-stone-100 text-stone-500 rounded">{tea.year}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${tea.type === "raw" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                        {tea.type === "raw" ? "生" : "熟"}
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-stone-400">
                      {tea.tastingNoteCount > 0 ? `${tea.tastingNoteCount} 篇品鉴` : "建档中"}
                      {tea.avgRating != null && ` · ★${tea.avgRating.toFixed(1)}`}
                    </div>
                    {market && (
                      <div className="mt-2 pt-2 border-t border-stone-100 flex items-center gap-1.5 text-xs">
                        <span className="text-stone-500">{market.price}</span>
                        {typeof market.changePct === "number" && (
                          <span className={market.changePct >= 0 ? "text-red-600" : "text-green-600"}>
                            {market.changePct >= 0 ? "▲" : "▼"}
                            {Math.abs(market.changePct).toFixed(1)}%
                          </span>
                        )}
                        {market.source && <span className="ml-auto text-[10px] text-stone-300">{market.source}</span>}
                      </div>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-16 border border-dashed border-stone-200 rounded-lg bg-white">
            <p className="text-stone-300 text-lg mb-1">🏵️</p>
            <p className="text-stone-500 text-sm mb-3">
              {brand || type || search ? "没有符合条件的经典茶品，试试调整筛选" : "经典茶品策展导入中"}
            </p>
            {!brand && !type && !search && (
              <Link href="/tea" className="text-sm text-amber-800 hover:text-amber-900 font-medium">
                先逛逛完整茶品库 →
              </Link>
            )}
          </div>
        )}
      </div>
      <LatestPosts />
    </div>
  );
}
