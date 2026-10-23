import { prisma } from "@/lib/prisma";
import { absImageUrl } from "@/lib/seo-image";
import { auth } from "@/lib/auth";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import ArticleCard from "@/components/tea/article-card";
import TastingCard from "@/components/tea/tasting-card";
import PromoteButton from "@/components/tea/promote-button";
import { LockedTip, LockedWallOverlay } from "@/components/tea/locked-tip";
import TeaBackButton from "@/components/tea/back-button";
import type { Prisma } from "@/generated/prisma/client";
import { visibleArticleWhere } from "@/lib/article-visibility";
import { safeJsonLdStringify } from "@/lib/json-ld";
import { parseMarket } from "@/lib/market-info";
import { isMirrorNoteLive } from "@/lib/tasting-note-plan";
import { getEditorLine } from "@/lib/editor-line-data";
import EditorLineView from "@/components/tea/editor-line";

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
  const tea = await prisma.tea.findFirst({
    where: { id, deletedAt: null },
    select: { name: true, brand: true, year: true, type: true, description: true, coverImage: true, isClassic: true },
  });
  if (!tea) return { title: "茶品未找到" };
  // 茶品库 = 全集；非经典（在建档/私人档案）的**详情**要求登录。
  // 正文 `:82` 会对未登录者 notFound()，但 metadata 是随 404 响应体的 RSC payload
  // 一起下发的 —— 不在这里也拦一道，未登录者就能从 404 的 HTML 里直接读到茶名/厂牌/年份。
  // 可见 <head> 会回退到根 layout，所以 Google 看不到，但原始 HTML 谁都能提取。
  if (!tea.isClassic && !(await auth())?.user) {
    return { title: "茶品未找到", robots: { index: false, follow: false } };
  }
  const teaType = tea.type === "raw" ? "生茶" : "熟茶";
  // P2-R11 SEO：年份+生熟+「普洱茶档案」进 title——茶友搜索习惯是
  // 「2003 大益 7542 生茶」这类精确词，档案页是承接这些长尾词的落地页。
  const title = `${tea.brand} ${tea.name}${tea.year ? ` ${tea.year}年` : ""} ${teaType}普洱茶档案`.trim();
  const description =
    tea.description ||
    `${tea.brand} ${tea.name}${tea.year ? `（${tea.year}年）` : ""} ${teaType}普洱茶档案：品鉴笔记、口感评测、仓储与行情讨论。`;
  const heroAbs = absImageUrl(tea.coverImage);
  return {
    title,
    description,
    keywords: [tea.name, tea.brand, "普洱茶", teaType, tea.year ? `${tea.year}年` : "", "品鉴", "茶档案"].filter(Boolean) as string[],
    alternates: { canonical: `/tea/${id}` },
    openGraph: {
      title: `${tea.brand} ${tea.name}${tea.year ? ` ${tea.year}年` : ""}`.trim(),
      description,
      ...(heroAbs ? { images: [{ url: heroAbs, width: 1200, height: 900, alt: title }] } : {}),
    },
  };
}

export default async function TeaDetailPage({ params }: PageProps) {
  const { id } = await params;
  const session = await auth();
  const canEdit = session?.user && session.user.level >= 2;
  const isAdmin = session?.user?.role === "admin";

  const tea = await prisma.tea.findFirst({
    where: { id, deletedAt: null },
    // 不再取 `_count`：两个计数都已改为直接用页面里实际渲染的条目数
    // （tastingNotes.length / articles.length），全表 _count 不带可见性过滤，
    // 会与渲染结果不一致。
    include: {
      user: { select: { username: true } },
    },
  }).catch(() => null);

  // 茶品库 = 全集：经典茶公开；非经典茶（在建档/私人档案）详情**需登录**。
  // 列表页对所有人列出全部茶品，所以未登录者点进来是常见路径 —— 这里引导登录
  // 并带回跳，而不是 404（404 会让「列表里明明有」变成死链）。
  // 经典茶详情页是 classics 流量承接页，保持公开。
  if (!tea) notFound();
  if (!tea.isClassic && !session?.user) {
    redirect(`/login?next=${encodeURIComponent(`/tea/${id}`)}`);
  }

  const [allTastingNotes, articles, editorLine] = await Promise.all([
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
        // 跟进帖会在发布时镜像出一条笔记（source="article" / sourceId=帖子 id）。
        // 这两个字段是**读取侧抑制**的依据：TastingNote 没有 status/visibility 列，
        // 笔记本身不知道源帖是否已下架/翻私密，只能靠 sourceId 回查。
        source: true,
        sourceId: true,
        author: { select: { username: true, avatar: true, level: true } },
      },
    }),
    prisma.article.findMany({
      where: { ...visibleArticleWhere(session?.user?.id), teaId: id },
      include: articleIncludes,
      orderBy: { createdAt: "desc" },
    }).catch(() => [] as ArticleWithRelations[]),
    // 站长线（PRD §5 Phase 1）：只取站长原始笔记，AI/帖子镜像不进。
    getEditorLine(id).catch(() => null),
  ]);

  // 镜像笔记的可见性跟随源帖：只保留源帖**当前**处于「已发布且非私密」的笔记。
  // `articles` 已由 visibleArticleWhere 过滤掉 archived / pending_review / 私密（非本人）；
  // 再显式剔除私密项，因为 visibleArticleWhere 会把「本人的私密帖」放进结果集 ——
  // 那条帖子的镜像笔记不该挂到公开的茶档案页上。
  // 这里刻意用**读取时抑制**而不是在下架时删笔记：归档是内容管理的可逆操作，
  // 而 Comment.tastingNoteId 是 onDelete: Cascade —— 删笔记会把笔记下的评论一起
  // 删掉。抑制是零写入的，重新发布后笔记连同评论原样回来。
  const liveNoteArticleIds = new Set(
    articles.filter((a) => a.visibility !== "private").map((a) => a.id),
  );
  const tastingNotes = allTastingNotes.filter((n) =>
    isMirrorNoteLive({ source: n.source, sourceId: n.sourceId }, liveNoteArticleIds),
  );

  // P2-R2 经典普洱：品鉴全文仍 admin-only（私人笔记），
  // 但对所有人公开"转化档案"摘要时间线（标题 + summary + 评分 + 首图）。
  const visibleNotes = isAdmin ? tastingNotes : [];

  // P2-R22 付费会员区预埋：目前无付费体系，全员（除 admin）仅见预览——
  // 转化档案摘要截断（约两行）、时间线不显示笔记图片、图片墙只输出前两行且加渐变锁定遮罩。
  // 受保护内容一律不进 SSR HTML（view-source 拿不到全文/图 URL）；接入付费体系后改此判断即可。
  const isPaidMember = false; // TODO(R22+): 付费会员体系（session 会员字段）
  const canViewFullArchive = isAdmin || isPaidMember;
  const ARCHIVE_PREVIEW_LEN = 64; // 摘要预览字数（约两行）
  const WALL_PREVIEW_COUNT = 10; // 图片墙两行（桌面 5 列 × 2）

  // Public conversion timeline (curated summary only), oldest → newest
  //
  // 站长的原始笔记**不**进这条时间线 —— 它们由「站长线」单独展示（带阶段、
  // 器具、来源声明）。这里只留社区的品鉴与跟进帖镜像，避免同一条记录出现两遍。
  const editorNoteIds = new Set((editorLine?.tastings ?? []).map((t) => t.id));
  const publicTimeline = tastingNotes
    .filter((n) => !editorNoteIds.has(n.id))
    .map((n) => {
      if (canViewFullArchive) {
        return {
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
        };
      }
      // 非付费：仅预览——截断摘要（SSR 不输出全文），不带笔记图片
      const preview =
        n.summary && n.summary.length > ARCHIVE_PREVIEW_LEN
          ? `${n.summary.slice(0, ARCHIVE_PREVIEW_LEN)}……`
          : n.summary;
      return {
        id: n.id,
        title: n.title,
        summary: preview,
        createdAt: n.createdAt,
        cover: null,
        scores: [n.appearance, n.color, n.aroma, n.taste, n.aftertaste].filter(
          (s): s is number => s !== null,
        ),
      };
    })
    .reverse();

  // Collect all images from tasting notes (evernote 图床 URL 本就公开)
  // P2-R22 非付费：只输出前两行进 HTML，其余图 URL 不下发
  const allNoteImages = tastingNotes.flatMap((n) =>
    Array.isArray(n.images)
      ? (n.images as unknown[]).filter((i): i is string => typeof i === "string")
      : [],
  );
  const allImages = canViewFullArchive ? allNoteImages : allNoteImages.slice(0, WALL_PREVIEW_COUNT);
  const hiddenWallCount = allNoteImages.length - allImages.length;

  const typeLabel = tea.type === "raw" ? "生茶" : "熟茶";
  const market = parseMarket(tea.marketInfo);

  // Aggregate scores
  const allScores = tastingNotes.flatMap((n) =>
    [n.appearance, n.color, n.aroma, n.taste, n.aftertaste].filter((s): s is number => s !== null),
  );
  const avgScore = allScores.length > 0
    ? (allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(1)
    : null;

  // P2-R11 SEO：hero 图三级链（封面→图库→茶记图）提前计算，JSON-LD 与页面共用
  const galleryFirstImg = Array.isArray(tea.gallery)
    ? (tea.gallery as unknown[]).find((u): u is string => typeof u === "string" && u.length > 0)
    : undefined;
  const noteFirstImg = tastingNotes
    .flatMap((n) => (Array.isArray(n.images) ? (n.images as unknown[]) : []))
    .find((u): u is string => typeof u === "string" && u.length > 0);
  // P2-R22 非付费：hero 不用笔记图兜底（仅茶品自身封面/图库），避免笔记大图全尺寸暴露
  const heroImgSrc = (tea.coverImage || galleryFirstImg || (canViewFullArchive ? noteFirstImg : undefined)) as string | undefined;
  const heroImgAbs = absImageUrl(heroImgSrc);
  const teaTypeLabel = tea.type === "raw" ? "生茶" : "熟茶";

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-10">
      {/* 不输出 BreadcrumbList：层级路径会暴露站内结构，产品上统一改为「返回」。 */}
      {/* Product JSON-LD（P2-R11：image + aggregateRating 提升图片收录与富摘要） */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLdStringify({
            "@context": "https://schema.org",
            "@type": "Product",
            name: `${tea.brand} ${tea.name} ${tea.year || ""}`.trim(),
            description: tea.description || `${tea.brand} ${tea.name} 普洱茶`,
            category: `普洱茶·${teaTypeLabel}`,
            brand: { "@type": "Brand", name: tea.brand },
            url: `https://puer.im/tea/${id}`,
            ...(heroImgAbs ? { image: heroImgAbs } : {}),
            ...(avgScore && allScores.length > 0
              ? {
                  aggregateRating: {
                    "@type": "AggregateRating",
                    ratingValue: avgScore,
                    bestRating: "5",
                    worstRating: "1",
                    ratingCount: allScores.length,
                  },
                }
              : {}),
          }),
        }}
      />
      {/* 返回（从哪里来回哪里去；不展示层级路径） */}
      <TeaBackButton />

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
            // 用页面里实际渲染的条目数，而不是 `_count.tastingNotes`：
            // 镜像笔记会因源帖下架/翻私密而被读取侧抑制，两者会不等，
            // 出现「标 3 篇、只列 2 篇」的自相矛盾。_count 是全表计数，不带任何过滤。
            { label: "品鉴笔记", value: tastingNotes.length },
            // 同理：_count.articles 从未套过 visibleArticleWhere，会把归档/私密帖算进去。
            { label: "论坛帖子", value: articles.length },
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

        {/* P2-R6 图片三级链：正面封面 → 图库第一张 → 最近品鉴笔记第一图（R11 起与 JSON-LD 共用并强化 alt） */}
        {heroImgSrc && (
          <img
            src={heroImgSrc}
            alt={`${tea.brand} ${tea.name}${tea.year ? ` ${tea.year}年` : ""} ${teaTypeLabel}普洱茶`}
            className="w-full max-h-96 object-cover rounded-lg mt-4"
          />
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

      {/* 站长线（PRD §5 Phase 1）— 站长一手品鉴时间轴 + 来源声明 */}
      {editorLine && (
        <EditorLineView
          tastings={editorLine.tastings.map((t) => ({
            ...t,
            // 摘要同属受保护内容：非付费/非 admin 只能拿到截断版（P2-R22）
            summary:
              !canViewFullArchive && t.summary && t.summary.length > ARCHIVE_PREVIEW_LEN
                ? `${t.summary.slice(0, ARCHIVE_PREVIEW_LEN)}……`
                : t.summary,
          }))}
          statement={editorLine.statement}
        />
      )}

      {/* P2-R2 转化档案 — 社区品鉴公开摘要时间线（非 admin 可见） */}
      {!isAdmin && publicTimeline.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg md:text-2xl font-serif font-bold text-stone-800 mb-1">
            社区品鉴 · 历年记录 ({publicTimeline.length})
          </h2>
          <p className="text-xs text-stone-400 mb-4">茶友们的品鉴摘要；站长的记录见上方「站长线」</p>
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
                      <img src={n.cover} alt={`${tea.name} 品鉴笔记：${n.title}`} loading="lazy" className="w-16 h-16 object-cover rounded-lg shrink-0" />
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
                        <p className="text-xs text-stone-500 mt-1 leading-relaxed line-clamp-2 md:line-clamp-2">{n.summary}</p>
                      )}
                      {!canViewFullArchive && (
                        <div className="mt-1.5 flex items-center justify-between">
                          <span className="text-[0.65rem] text-stone-400">完整品鉴内容仅付费会员可见</span>
                          <LockedTip label="查看完整品鉴 →" />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Image Wall — P2-R22 非付费仅前两行进 HTML + 渐变锁定遮罩（不可点击查看大图） */}
      {allImages.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg md:text-2xl font-serif font-bold text-stone-800 mb-4">
            图片墙 ({canViewFullArchive ? allImages.length : `${allImages.length}${hiddenWallCount > 0 ? `/${allImages.length + hiddenWallCount}` : ""}`})
          </h2>
          <div className="relative">
            <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
              {allImages.map((src, i) =>
                canViewFullArchive ? (
                  <a key={i} href={src} target="_blank" rel="noopener noreferrer"
                    className="aspect-square rounded-lg overflow-hidden bg-stone-100"
                  >
                    <img src={src} alt={`${tea.brand} ${tea.name} 图片`} className="w-full h-full object-cover hover:opacity-85 transition" />
                  </a>
                ) : (
                  <div key={i} className="aspect-square rounded-lg overflow-hidden bg-stone-100">
                    <img
                      src={src}
                      alt={`${tea.brand} ${tea.name} 图片预览`}
                      loading="lazy"
                      draggable={false}
                      className="w-full h-full object-cover pointer-events-none select-none"
                    />
                  </div>
                ),
              )}
            </div>
            {!canViewFullArchive && <LockedWallOverlay hiddenCount={hiddenWallCount} />}
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
