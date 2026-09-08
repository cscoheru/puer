import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

const BRANDS = ["大益", "下关", "福今", "陈升号", "宝和祥", "今大福", "勐库戎氏", "中茶", "老班章"];

interface PageProps {
  searchParams: Promise<{ q?: string; brand?: string; year?: string; page?: string }>;
}

export default async function TastingListPage({ searchParams }: PageProps) {
  const user = await auth();

  if (user?.user?.role !== "admin") notFound();

  const params = await searchParams;
  const q = params.q || "";
  const brand = params.brand || "";
  const year = params.year || "";
  const page = Math.max(1, parseInt(params.page || "1"));
  const limit = 24;

  // Build where clause
  const where: Record<string, unknown> = {};
  const AND: Record<string, unknown>[] = [];

  if (brand) {
    AND.push({ tea: { brand } });
  }
  if (year) {
    AND.push({ tea: { year: parseInt(year) } });
  }
  if (q) {
    AND.push({
      OR: [
        { title: { contains: q, mode: "insensitive" as const } },
        { content: { contains: q, mode: "insensitive" as const } },
        { summary: { contains: q, mode: "insensitive" as const } },
      ],
    });
  }
  if (AND.length > 0) where.AND = AND;

  const [notes, total] = await Promise.all([
    prisma.tastingNote.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        tea: { select: { id: true, name: true, brand: true, year: true, type: true } },
        author: { select: { id: true, username: true, avatar: true, level: true } },
      },
    }),
    prisma.tastingNote.count({ where }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="max-w-6xl mx-auto px-3 md:px-4 py-6">
      {/* Breadcrumb */}
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">首页</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">茶记</span>
      </nav>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl md:text-3xl font-serif font-bold text-stone-800">
          茶记
          <span className="text-sm font-normal text-stone-400 ml-2">({total} 篇)</span>
        </h1>
        <Link href="/tasting/new" className="px-4 py-2 bg-amber-800 text-white rounded-lg text-sm hover:bg-amber-900 transition">
          ✏️ 发布茶记
        </Link>
      </div>

      {/* Search & Filters */}
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
        <input name="q" type="text" placeholder="搜索茶记..." defaultValue={q}
          className="flex-1 min-w-[200px] px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40"
        />
        <button type="submit"
          className="px-4 py-2 bg-stone-800 text-white rounded-lg text-sm hover:bg-stone-900 transition"
        >
          搜索
        </button>
        {(q || brand || year) && (
          <Link href="/tasting"
            className="px-4 py-2 text-stone-500 text-sm hover:text-stone-700 transition"
          >
            清除筛选
          </Link>
        )}
      </form>

      {/* Grid */}
      {notes.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {notes.map((note) => {
            const images: string[] = Array.isArray(note.images)
              ? (note.images as unknown[]).filter((i): i is string => typeof i === "string")
              : [];
            const plainText = note.summary || note.content.replace(/<[^>]*>/g, "").slice(0, 200);

            return (
              <Link
                key={note.id}
                href={`/tasting/${note.id}`}
                className="block bg-white rounded-xl border border-stone-200 overflow-hidden hover:shadow-md hover:border-amber-300 transition group"
              >
                {images.length > 0 ? (
                  <div className="h-40 bg-stone-100 overflow-hidden">
                    <img src={images[0]} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                  </div>
                ) : (
                  <div className="h-40 bg-gradient-to-br from-amber-50 to-stone-100 flex items-center justify-center">
                    <span className="text-4xl">📝</span>
                  </div>
                )}
                <div className="p-3 space-y-2">
                  <h2 className="font-medium text-stone-800 line-clamp-1 group-hover:text-amber-800 transition">
                    {note.title}
                  </h2>
                  {note.tea && (
                    <div className="flex flex-wrap gap-1">
                      <span className="text-[10px] px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded">
                        {note.tea.brand}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 bg-stone-100 text-stone-500 rounded">
                        {note.tea.year}
                      </span>
                      {note.tea.name && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-stone-50 text-stone-600 rounded">
                          {note.tea.name}
                        </span>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-stone-500 line-clamp-2 leading-relaxed">
                    {plainText}
                  </p>
                  <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center gap-1.5 text-xs text-stone-400">
                      <img
                        src={note.author.avatar || "/default-avatar.svg"}
                        alt=""
                        className="w-4 h-4 rounded-full object-cover"
                      />
                      <span>{note.author.username}</span>
                    </div>
                    <span className="text-[10px] text-stone-300">
                      {new Date(note.createdAt).toLocaleDateString("zh-CN")}
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-16 text-stone-400">
          <div className="text-5xl mb-4">📖</div>
          <p>暂无茶记</p>
          {q && <p className="text-sm mt-1">换个关键词试试</p>}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-8">
          {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((p) => {
            const sp = new URLSearchParams({ q, brand, year, page: String(p) });
            return (
              <Link
                key={p}
                href={`/tasting?${sp}`}
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
