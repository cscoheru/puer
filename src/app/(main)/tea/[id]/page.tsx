import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import ArticleCard from "@/components/tea/article-card";
import TastingCard from "@/components/tea/tasting-card";
import PromoteButton from "@/components/tea/promote-button";
import type { Prisma } from "@/generated/prisma/client";
import { visibleArticleWhere } from "@/lib/article-visibility";
import { safeJsonLdStringify } from "@/lib/json-ld";
import { parseMarket } from "@/lib/market-info";

export const dynamic = "force-dynamic";

const articleIncludes = {
  author: { select: { username: true, avatar: true, level: true } },
  tea: { select: { name: true, brand: true, year: true } },
  _count: { select: { comments: true, likes: true } },
} satisfies Prisma.ArticleInclude;

type ArticleWithRelations = Prisma.ArticleGetPayload<{ include: typeof articleIncludes }>;

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const tea = await prisma.tea.findUnique({
    where: { id },
    select: { name: true, brand: true, year: true, type: true, description: true },
  });
  if (!tea) return { title: "茶品未找到" };
  const typeLabel = tea.year ? `${tea.year}年` : "";
  const teaType = tea.type === "raw" ? "生茶" : "熟茶";
  return {
    title: `${tea.brand} ${tea.name} ${typeLabel}`.trim(),
    description: tea.description || `${tea.brand} ${tea.name}${tea.year ? `（${tea.year}年）` : ""} ${teaType} — 普洱茶品详情、品鉴笔记与讨论`,
    keywords: [tea.name, tea.brand, "普洱茶", teaType, tea.year ? `${tea.year}年` : ""].filter(Boolean),
    alternates: { canonical: `/tea/${id}` },
    openGraph: {
      title: `${tea.brand} ${tea.name}`,
      description: `${tea.brand} ${tea.name} 普洱茶品详情`,
    },
  };
}

export default async function TeaDetailPage({ params }: PageProps) {
  const { id } = await params;
  const session = await auth();
  const canEdit = session?.user && session.user.level >= 2;
  const isAdmin = session?.user?.role === "admin";

  const tea = await prisma.tea.findUnique({
    where: { id },
    include: {
      _count: { select: { articles: true, tastingNotes: true } },
      user: { select: { username: true } },
    },
  }).catch(() => null);

  if (!tea) notFound();

  const [tastingNotes, articles] = await Promise.all([
    prisma.tastingNote.findMany({
      where: { teaId: id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        summary: true,
        appearance: true,
        color: true,
        aroma: true,
        taste: true,
        aftertaste: true,
        images: true,
        createdAt: true,
        author: { select: { username: true, avatar: true, level: true } },
      },
    }),
    prisma.article.findMany({
      where: { ...visibleArticleWhere(session?.user?.id), teaId: id },
      include: articleIncludes,
      orderBy: { createdAt: "desc" },
    }).catch(() => [] as ArticleWithRelations[]),
  ]);

  // P2-R2 经典普洱：品鉴全文仍 admin-only（私人笔记），
  // 但对所有人公开"转化档案"摘要时间线（标题 + summary + 评分 + 首图）。
  const visibleNotes = isAdmin ? tastingNotes : [];

  // Public conversion timeline (curated summary only), oldest → newest
  const publicTimeline = tastingNotes
    .map((n) => ({
      id: n.id,
      title: n.title,
      summary: n.summary,
      createdAt: n.createdAt,
      cover:
        Array.isArray(n.images)
          ? ((n.images as unknown[]).find((i): i is string => typeof i === "string") ?? null)
          : null,
      scores: [n.appearance, n.color, n.aroma, n.taste, n.aftertaste].filter(
        (s): s is number => s !== null,
      ),
    }))
    .reverse();

  // Collect all images from tasting notes (evernote 图床 URL 本就公开)
  const allImages = tastingNotes.flatMap((n) =>
    Array.isArray(n.images)
      ? (n.images as unknown[]).filter((i): i is string => typeof i === "string")
      : [],
  );

  const typeLabel = tea.type === "raw" ? "生茶" : "熟茶";
  const market = parseMarket(tea.marketInfo);

  // Aggregate scores
  const allScores = tastingNotes.flatMap((n) =>
    [n.appearance, n.color, n.aroma, n.taste, n.aftertaste].filter((s): s is number => s !== null),
  );
  const avgScore = allScores.length > 0
    ? (allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(1)
    : null;

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-10">
      {/* Product JSON-LD */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLdStringify({
            "@context": "https://schema.org",
            "@type": "Product",
            name: `${tea.brand} ${tea.name} ${tea.year || ""}`.trim(),
            description: tea.description || `${tea.brand} ${tea.name} 普洱茶`,
            brand: { "@type": "Brand", name: tea.brand },
            url: `https://puer.im/tea/${id}`,
          }),
        }}
      />
      {/* Breadcrumb */}
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">品茶论坛</Link>
        <span className="mx-2">/</span>
        {tea.isClassic && (
          <>
            <Link href="/forum/classics" className="hover:text-amber-700 transition">经典普洱</Link>
            <span className="mx-2">/</span>
          </>
        )}
        <Link href="/tea" className="hover:text-amber-700 transition">茶品库</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">{tea.name}</span>
      </nav>

      {/* Header */}
      <div className="bg-white rounded-xl border border-stone-200 p-5 md:p-8 mb-6">
        <h1 className="text-2xl md:text-4xl font-serif font-bold text-stone-800">{tea.name}</h1>
        <div className="flex flex-wrap gap-2 mt-3">
          <span className="px-2.5 py-0.5 bg-amber-100 text-amber-800 rounded text-xs font-medium">
            {tea.brand}
          </span>
          <span className="px-2.5 py-0.5 bg-stone-100 text-stone-600 rounded text-xs">
            {tea.year}年
          </span>
          <span className={`px-2.5 py-0.5 rounded text-xs ${typeLabel === "生茶" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
            {typeLabel}
          </span>
          {tea.batch && (
            <span className="px-2.5 py-0.5 bg-stone-100 text-stone-600 rounded text-xs">
              第{tea.batch}批
            </span>
          )}
          {tea.isClassic && (
            <span className="px-2.5 py-0.5 bg-amber-800 text-white rounded text-xs font-medium">
              🏵️ 经典普洱
            </span>
          )}
        </div>

        {canEdit && (
          <div className="mt-4">
            <Link href={`/encyclopedia/${id}/edit`} className="text-sm text-amber-700 hover:text-amber-800 border border-amber-300 px-3 py-1.5 rounded-lg hover:bg-amber-50 transition">
              编辑
            </Link>
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mt-6 text-center">
          {[
            { label: "品鉴笔记", value: tea._count.tastingNotes },
            { label: "论坛帖子", value: tea._count.articles },
            { label: "综合评分", value: avgScore ? `★ ${avgScore}` : "暂无" },
            { label: "规格", value: tea.weightSpec || "未知" },
            { label: "仓储", value: tea.storageCondition || "未知" },
          ].map(({ label, value }) => (
            <div key={label} className="p-3 bg-stone-50 rounded-lg">
              <div className="text-lg md:text-xl font-bold text-amber-800">{value}</div>
              <div className="text-xs text-stone-400 mt-0.5">{label}</div>
            </div>
          ))}
        </div>

        {market && (
          <div className="mt-4 flex flex-wrap items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-sm">
            <span className="text-stone-500 text-xs">行情快照</span>
            <span className="font-semibold text-stone-800">{market.price}</span>
            {typeof market.changePct === "number" && (
              <span className={`font-medium ${market.changePct >= 0 ? "text-red-600" : "text-green-600"}`}>
                {market.changePct >= 0 ? "▲" : "▼"} {Math.abs(market.changePct).toFixed(1)}%
              </span>
            )}
            {market.updatedAt && <span className="text-xs text-stone-400">{market.updatedAt}</span>}
            {market.source && <span className="ml-auto text-xs text-stone-400">来源：{market.source}</span>}
          </div>
        )}

        {tea.description && (
          <p className="text-stone-600 text-sm md:text-base mt-4 leading-relaxed">{tea.description}</p>
        )}

        {tea.coverImage && (
          <img src={tea.coverImage} alt={tea.name} className="w-full max-h-96 object-cover rounded-lg mt-4" />
        )}

        <div className="text-xs text-stone-400 mt-4">
          创建者: {tea.user.username} · {new Date(tea.createdAt).toLocaleDateString("zh-CN")}
        </div>
      </div>

      {/* Tasting Notes (admin-only) */}
      {isAdmin && (
      <div className="mb-8">
        <h2 className="text-lg md:text-2xl font-serif font-bold text-stone-800 mb-4">
          品鉴笔记 ({visibleNotes.length})
        </h2>
        {visibleNotes.length > 0 ? (
          <div className="space-y-3">
            {visibleNotes.map((note) => (
              <div key={note.id} className="relative">
                <TastingCard note={note} />
                {isAdmin && (
                  <div className="absolute top-2 right-2">
                    <PromoteButton tastingNoteId={note.id} tastingNoteTitle={note.title} />
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-center text-stone-400 py-8 bg-white rounded-xl border border-dashed border-stone-200 text-sm">
            还没有品鉴记录
          </p>
        )}
      </div>
      )}

      {/* P2-R2 转化档案 — 历年品鉴公开摘要时间线（非 admin 可见） */}
      {!isAdmin && publicTimeline.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg md:text-2xl font-serif font-bold text-stone-800 mb-1">
            转化档案 · 历年品鉴 ({publicTimeline.length})
          </h2>
          <p className="text-xs text-stone-400 mb-4">从第一次开汤到最近的品鉴摘要，跟踪这款茶的状态变化</p>
          <div className="relative border-l-2 border-amber-200 ml-2 space-y-4">
            {publicTimeline.map((n) => {
              const avg =
                n.scores.length > 0
                  ? (n.scores.reduce((a, b) => a + b, 0) / n.scores.length).toFixed(1)
                  : null;
              return (
                <div key={n.id} className="relative pl-6">
                  <span className="absolute -left-[9px] top-2 w-4 h-4 rounded-full bg-amber-700 border-2 border-white" />
                  <div className="bg-white border border-stone-200 rounded-lg p-3 flex gap-3">
                    {n.cover && (
                      <img src={n.cover} alt="" loading="lazy" className="w-16 h-16 object-cover rounded-lg shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-amber-800">
                          {new Date(n.createdAt).getFullYear()} 年
                        </span>
                        <span className="text-xs text-stone-400">
                          {new Date(n.createdAt).toLocaleDateString("zh-CN")}
                        </span>
                        {avg && <span className="text-xs text-amber-700">★ {avg}</span>}
                      </div>
                      <p className="text-sm font-medium text-stone-800 mt-0.5 truncate">{n.title}</p>
                      {n.summary && (
                        <p className="text-xs text-stone-500 mt-1 leading-relaxed line-clamp-3">{n.summary}</p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Image Wall */}
      {allImages.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg md:text-2xl font-serif font-bold text-stone-800 mb-4">
            图片墙 ({allImages.length})
          </h2>
          <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
            {allImages.map((src, i) => (
              <a key={i} href={src} target="_blank" rel="noopener noreferrer"
                className="aspect-square rounded-lg overflow-hidden bg-stone-100"
              >
                <img src={src} alt="" className="w-full h-full object-cover hover:opacity-85 transition" />
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Forum Articles */}
      <div>
        <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
          <h2 className="text-lg md:text-2xl font-serif font-bold text-stone-800">
            关联帖子 ({articles.length})
          </h2>
          {/* P2-R2 跟进发帖：档案创建者与茶友均可为该茶发布跟进帖（转化观察/行情/开汤） */}
          {session?.user ? (
            <Link
              href={`/forum/new?board=classics&tea=${tea.id}&teaName=${encodeURIComponent(tea.name)}&teaBrand=${encodeURIComponent(tea.brand)}&teaYear=${tea.year}&title=${encodeURIComponent(`【跟进】${tea.name}`)}`}
              className="px-3 py-1.5 text-xs md:text-sm rounded-lg bg-amber-800 text-white hover:bg-amber-900 transition font-medium"
            >
              ✏️ 发布跟进帖
            </Link>
          ) : (
            <Link href="/login" className="text-xs md:text-sm text-amber-800 hover:text-amber-900 font-medium">
              登录后可发布跟进帖 →
            </Link>
          )}
        </div>
        {articles.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-5">
            {articles.map((article: ArticleWithRelations) => (
              <ArticleCard key={article.id} article={article} />
            ))}
          </div>
        ) : (
          <div className="text-center py-8 bg-white rounded-xl border border-dashed border-stone-200">
            <p className="text-stone-400 text-sm mb-3">暂无关联帖子</p>
            {session?.user && (
              <Link
                href={`/forum/new?board=classics&tea=${tea.id}&teaName=${encodeURIComponent(tea.name)}&teaBrand=${encodeURIComponent(tea.brand)}&teaYear=${tea.year}&title=${encodeURIComponent(`【跟进】${tea.name}`)}`}
                className="text-sm text-amber-800 hover:text-amber-900 font-medium"
              >
                发布第一篇跟进帖 →
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
