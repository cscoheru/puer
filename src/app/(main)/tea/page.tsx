import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import Link from "next/link";
import type { Metadata } from "next";
import { TeaGrid } from "@/components/tea/tea-list";
import { LANDING_MIN_TEAS, PREFERRED_BRANDS, normalizeTeaType, teaListSelect } from "@/lib/tea-query";

export const metadata: Metadata = {
  title: "普洱茶库 - 经典普洱茶品大全（大益/下关/福今）",
  description:
    "普洱茶品大全：收录各大品牌、各年份经典普洱茶档案，含生茶/熟茶分类、口感评分、历年品鉴记录与东和行情。按品牌、年份、生熟筛选。",
  keywords: ["普洱茶", "普洱茶品牌", "茶品库", "茶叶评测", "普洱茶评分", "大益生普", "下关沱茶"],
  alternates: { canonical: "/tea" },
};

export const dynamic = "force-dynamic";

const LIMIT = 24;

interface PageProps {
  searchParams: Promise<{ brand?: string; year?: string; type?: string; q?: string; page?: string }>;
}

/** 分页器窗口：首页 + 末页 + 当前页 ±2，中间用省略号 */
function pageWindow(current: number, total: number): (number | "…")[] {
  const wanted = new Set<number>([1, total, current, current - 1, current + 1, current - 2, current + 2]);
  const nums = [...wanted].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  for (let i = 0; i < nums.length; i++) {
    if (i > 0 && nums[i] - nums[i - 1] > 1) out.push("…");
    out.push(nums[i]);
  }
  return out;
}

export default async function TeaListPage({ searchParams }: PageProps) {
  // P1-1（原 P2-R23 茶品库对用户隐藏）：改为公开的经典茶浏览入口。
  // 非经典茶（私人档案/在建档）不进列表 —— 与 /tea/[id] 的 notFound 条件一致。
  const session = await auth();
  const isAdmin = session?.user?.role === "admin";
  const params = await searchParams;
  const brand = params.brand || "";
  const year = params.year || "";
  const type = normalizeTeaType(params.type) ?? "";
  const search = (params.q || "").slice(0, 64);
  // 公开页必须容错：`?year=abc` 会让 parseInt 得到 NaN，而 Prisma 对 Int 字段收到
  // NaN 会抛 PrismaClientValidationError（500）；`?page=1e21` 同理会让 skip 溢出 Int。
  const parsedYear = Number.parseInt(year, 10);
  const parsedPage = Number.parseInt(params.page || "1", 10);
  const page = Math.min(Math.max(1, Number.isFinite(parsedPage) ? parsedPage : 1), 500);

  const where: Record<string, unknown> = { deletedAt: null, isClassic: true };
  if (brand) where.brand = brand;
  if (Number.isFinite(parsedYear)) where.year = parsedYear;
  if (type) where.type = type;
  if (search) where.name = { contains: search, mode: "insensitive" } as const;

  const [teas, total, brandGroups] = await Promise.all([
    prisma.tea.findMany({
      where,
      orderBy: [{ tastingNoteCount: "desc" }, { year: "desc" }, { name: "asc" }],
      skip: (page - 1) * LIMIT,
      take: LIMIT,
      select: teaListSelect,
    }),
    prisma.tea.count({ where }),
    // 品牌落地页导航（只列够厚的，与 sitemap / 落地页 notFound 阈值一致）
    prisma.tea
      .groupBy({
        by: ["brand"],
        where: { deletedAt: null, isClassic: true },
        _count: { _all: true },
      })
      .catch(() => []),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  const landingBrands = brandGroups
    .filter((g) => g._count._all >= LANDING_MIN_TEAS && g.brand && g.brand !== "未知")
    .sort((a, b) => b._count._all - a._count._all);

  const filterHref = (over: Record<string, string>) => {
    const sp = new URLSearchParams({ brand, year, type, q: search, ...over });
    for (const [k, v] of [...sp.entries()]) if (!v || (k === "page" && v === "1")) sp.delete(k);
    const qs = sp.toString();
    return `/tea${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-8 py-6 md:py-10">
      {/* Breadcrumb */}
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">品茶论坛</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">茶品库</span>
      </nav>

      <div className="flex items-center justify-between mb-4 gap-3">
        <h1 className="text-2xl md:text-3xl font-serif font-bold text-stone-800">普洱茶库</h1>
        {isAdmin && (
          <Link
            href="/encyclopedia/new"
            className="shrink-0 text-sm bg-amber-800 text-white px-4 py-2 rounded-lg hover:bg-amber-900 transition"
          >
            新增茶品
          </Link>
        )}
      </div>

      <p className="text-sm text-stone-500 leading-relaxed mb-6">
        收录经典普洱茶档案 {total} 款，含大益、下关、福今等厂牌各年份生茶与熟茶：
        品种档案、历年品鉴记录、口感评分与东和行情快照。
      </p>

      {/* 聚合落地页内链（爬虫与用户都能由此进入品牌/生熟/年份页） */}
      <div className="flex flex-wrap items-center gap-2 mb-6 text-xs">
        <span className="text-stone-400">按分类浏览：</span>
        <Link href="/tea/type/raw" className="px-2.5 py-1 rounded-full bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition">生茶</Link>
        <Link href="/tea/type/ripe" className="px-2.5 py-1 rounded-full bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 transition">熟茶</Link>
        {landingBrands.slice(0, 8).map((g) => (
          <Link
            key={g.brand}
            href={`/tea/brand/${encodeURIComponent(g.brand)}`}
            className="px-2.5 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 transition"
          >
            {g.brand} <span className="text-amber-600/70">{g._count._all}</span>
          </Link>
        ))}
      </div>

      {/* Filters */}
      <form method="GET" className="flex flex-wrap gap-3 mb-6">
        <select name="brand" defaultValue={brand}
          className="px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/40"
        >
          <option value="">全部品牌</option>
          {PREFERRED_BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
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
        <TeaGrid teas={teas} />
      ) : (
        <p className="text-center text-stone-400 py-16 bg-white rounded-xl border border-dashed border-stone-200 text-sm">
          暂无茶品数据，试试调整筛选条件
        </p>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex flex-wrap justify-center items-center gap-2 mt-8">
          {page > 1 && (
            <Link href={filterHref({ page: String(page - 1) })}
              className="px-3 py-1.5 rounded text-sm bg-stone-100 text-stone-600 hover:bg-stone-200 transition">
              上一页
            </Link>
          )}
          {pageWindow(page, totalPages).map((p, i) =>
            p === "…" ? (
              <span key={`gap-${i}`} className="px-1 text-stone-300 text-sm">…</span>
            ) : (
              <Link
                key={p}
                href={filterHref({ page: String(p) })}
                className={`px-3 py-1.5 rounded text-sm transition ${
                  p === page ? "bg-amber-800 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"
                }`}
              >
                {p}
              </Link>
            ),
          )}
          {page < totalPages && (
            <Link href={filterHref({ page: String(page + 1) })}
              className="px-3 py-1.5 rounded text-sm bg-stone-100 text-stone-600 hover:bg-stone-200 transition">
              下一页
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
