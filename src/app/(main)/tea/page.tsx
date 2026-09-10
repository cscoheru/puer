import { prisma } from "@/lib/prisma";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "普洱茶库 - 茶品大全",
  description: "普洱茶品大全。收录各大品牌、各年份普洱茶品评测、口感评分、茶友点评。",
  keywords: ["普洱茶", "茶品库", "茶叶评测", "普洱茶品牌", "茶叶评分"],
  alternates: { canonical: "/tea" },
};

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ brand?: string; year?: string; type?: string; q?: string; page?: string }>;
}

const BRANDS = ["大益", "下关", "福今", "陈升号", "宝和祥", "今大福", "勐库戎氏", "中茶", "老班章"];

export default async function TeaListPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const brand = params.brand || "";
  const year = params.year || "";
  const type = params.type || "";
  const search = params.q || "";
  const page = Math.max(1, parseInt(params.page || "1"));
  const limit = 24;

  const where: Record<string, unknown> = {};
  if (brand) where.brand = brand;
  if (year) where.year = parseInt(year);
  if (type) where.type = type;
  if (search) where.name = { contains: search, mode: "insensitive" } as const;

  const [teas, total] = await Promise.all([
    prisma.tea.findMany({
      where,
      orderBy: [{ tastingNoteCount: "desc" }, { year: "desc" }, { name: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.tea.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-8 py-6 md:py-10">
      {/* Breadcrumb */}
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">品茶论坛</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">茶品库</span>
      </nav>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl md:text-3xl font-serif font-bold text-stone-800">茶品库</h1>
        <Link
          href="/encyclopedia/new"
          className="text-sm bg-amber-800 text-white px-4 py-2 rounded-lg hover:bg-amber-900 transition"
        >
          新增茶品
        </Link>
      </div>

      {/* Filters */}
      <form method="GET" className="flex flex-wrap gap-3 mb-6">
        <select name="brand" defaultValue={brand}
          className="px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/40"
        >
          <option value="">全部品牌</option>
          {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <input name="year" type="number" placeholder="年份" defaultValue={year}
          className="w-24 px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40"
        />
        <select name="type" defaultValue={type}
          className="px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/40"
        >
          <option value="">全部类型</option>
          <option value="raw">生茶</option>
          <option value="ripe">熟茶</option>
        </select>
        <input name="q" type="text" placeholder="搜索茶品..." defaultValue={search}
          className="flex-1 min-w-[200px] px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40"
        />
        <button type="submit"
          className="px-4 py-2 bg-stone-800 text-white rounded-lg text-sm hover:bg-stone-900 transition"
        >
          筛选
        </button>
      </form>

      {/* Grid */}
      {teas.length > 0 ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {teas.map((tea) => (
            <Link
              key={tea.id}
              href={`/tea/${tea.id}`}
              className="block bg-white rounded-xl border border-stone-200 overflow-hidden hover:shadow-md hover:border-amber-300 transition group"
            >
              {tea.coverImage ? (
                <div className="aspect-square bg-stone-100">
                  <img src={tea.coverImage} alt={tea.name} className="w-full h-full object-cover" />
                </div>
              ) : (
                <div className="aspect-square bg-gradient-to-br from-amber-50 to-stone-100 flex items-center justify-center">
                  <span className="text-4xl">🍵</span>
                </div>
              )}
              <div className="p-3">
                <h3 className="font-medium text-stone-800 text-sm truncate group-hover:text-amber-800 transition">
                  {tea.name}
                </h3>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  <span className="text-[0.625rem] px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded">{tea.brand}</span>
                  <span className="text-[0.625rem] px-1.5 py-0.5 bg-stone-100 text-stone-500 rounded">{tea.year}</span>
                  <span className={`text-[0.625rem] px-1.5 py-0.5 rounded ${tea.type === "raw" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                    {tea.type === "raw" ? "生" : "熟"}
                  </span>
                </div>
                {tea.tastingNoteCount > 0 && (
                  <p className="text-xs text-stone-400 mt-2">
                    {tea.tastingNoteCount} 篇品鉴
                    {tea.avgRating && <span> · ★ {tea.avgRating.toFixed(1)}</span>}
                  </p>
                )}
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-center text-stone-400 py-16 bg-white rounded-xl border border-dashed border-stone-200 text-sm">
          暂无茶品数据，试试调整筛选条件
        </p>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-8">
          {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((p) => {
            const sp = new URLSearchParams({ brand, year, type, q: search, page: String(p) });
            return (
              <Link
                key={p}
                href={`/tea?${sp}`}
                className={`px-3 py-1.5 rounded text-sm transition ${
                  p === page
                    ? "bg-amber-800 text-white"
                    : "bg-stone-100 text-stone-600 hover:bg-stone-200"
                }`}
              >
                {p}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
