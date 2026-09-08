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

  // Tasting notes are admin-only; hide entirely from non-admins
  const visibleNotes = isAdmin ? tastingNotes : [];

  // Collect all images from tasting notes
  const allImages = visibleNotes.flatMap((n) =>
    Array.isArray(n.images)
      ? (n.images as unknown[]).filter((i): i is string => typeof i === "string")
      : [],
  );

  const typeLabel = tea.type === "raw" ? "生茶" : "熟茶";

  // Aggregate scores
  const allScores = visibleNotes.flatMap((n) =>
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
            { label: "品鉴笔记", value: isAdmin ? tea._count.tastingNotes : 0 },
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
        <h2 className="text-lg md:text-2xl font-serif font-bold text-stone-800 mb-4">
          关联帖子 ({articles.length})
        </h2>
        {articles.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-5">
            {articles.map((article: ArticleWithRelations) => (
              <ArticleCard key={article.id} article={article} />
            ))}
          </div>
        ) : (
          <p className="text-center text-stone-400 py-8 bg-white rounded-xl border border-dashed border-stone-200 text-sm">
            暂无关联帖子
          </p>
        )}
      </div>
    </div>
  );
}
