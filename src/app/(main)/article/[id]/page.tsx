import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLevelName } from "@/lib/level-config";
import { canViewArticleDetail } from "@/lib/article-visibility";
import LikeButton from "@/components/like-button";
import ShareButton from "@/components/share-button";
import FavoriteButton from "@/components/favorite-button";
import CommentSection from "@/components/comment-section";
import ForumContent from "@/components/forum-content";
import OriginDisclosure from "@/components/article/origin-disclosure";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ArticleDetailPage({ params }: PageProps) {
  const { id } = await params;

  const article = await prisma.article.findUnique({
    where: { id },
    include: {
      author: { select: { id: true, username: true, avatar: true, level: true, bio: true } },
      tea: true,
      _count: { select: { comments: true, likes: true } },
    },
  }).catch(() => { console.warn("[ArticleDetail] DB unavailable"); return null; });

  const session = await auth();
  // 可见性判定与 forum/thread/[id] **同源**（canViewArticleDetail）：只有
  // published+public 对所有人可见；draft/pending/rejected 仅作者与管理员可见；
  // archived 仅管理员；未知状态一律拒绝（fail-closed）。
  //
  // 之前这里是手写的白名单（只排 archived 与 pending_review），漏掉了 draft
  // 与新加的 rejected —— 知道 id 就能在公网读到未发布的稿子。改用共享判定后
  // 两处页面口径一致，且新状态值不需要再逐个补白名单。
  if (
    !article ||
    !canViewArticleDetail(
      { status: article.status, visibility: article.visibility, authorId: article.authorId },
      { userId: session?.user?.id, isAdmin: session?.user?.role === "admin" },
    )
  ) {
    notFound();
  }

  let initialLiked = false;
  let initialFavorited = false;
  if (session?.user) {
    const [like, fav] = await Promise.all([
      prisma.like.findUnique({
        where: { userId_type_refId: { userId: session.user.id, type: "article", refId: id } },
      }).catch(() => null),
      prisma.favorite.findUnique({
        where: { userId_articleId: { userId: session.user.id, articleId: id } },
      }).catch(() => null),
    ]);
    initialLiked = !!like;
    initialFavorited = !!fav;
  }

  const authorLevelName = await getLevelName(article.author.level);

  const dateStr = new Date(article.createdAt).toLocaleDateString("zh-CN", {
    year: "numeric", month: "long", day: "numeric",
  });

  const shareUrl = `${process.env.NEXT_PUBLIC_SITE_URL || ""}/article/${id}`;

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-10">
      {/* Breadcrumb */}
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/" className="hover:text-amber-700 transition">首页</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">{article.title}</span>
      </nav>

      {/* Article */}
      <article className="bg-white rounded-xl border border-stone-200 p-5 md:p-8">
        <h1 className="text-2xl md:text-4xl font-serif font-bold text-stone-800 leading-tight">
          {article.title}
        </h1>

        {/* Meta */}
        <div className="flex flex-wrap items-center gap-3 mt-4 text-sm text-stone-400">
          <Link href={`/user/${article.author.id}`} className="flex items-center gap-2 hover:text-amber-700 transition">
            <span className="text-amber-700 text-xs">
              Lv.{article.author.level} {authorLevelName}
            </span>
            <span>{article.author.username}</span>
          </Link>
          <span>·</span>
          <span>{dateStr}</span>
          <span>·</span>
          <span>{article._count.comments} 评论</span>
          <span>{article._count.likes} 赞</span>
          <span>·</span>
          <span>{article.viewCount} 阅读</span>
        </div>

        {/* F0 来源标注：AI 整理 / 全自动文章必须可区分（PRD v0.3 §7 F0） */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <OriginDisclosure origin={article.origin} sourceUrls={article.sourceUrls} />
        </div>

        {/* Tags */}
        {article.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {article.tags.map((tag) => (
              <span key={tag} className="px-2 py-0.5 bg-amber-50 text-amber-700 rounded text-xs">
                #{tag}
              </span>
            ))}
          </div>
        )}

        {/* Tea info for tastings */}
        {article.tea && (
          <div className="bg-stone-50 rounded-lg p-4 mt-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-stone-400">品鉴茶品</p>
              <Link href={`/tea/${article.tea.id}`} className="text-sm font-medium text-amber-800 hover:text-amber-900 transition">
                {article.tea.brand} · {article.tea.year} · {article.tea.name}
              </Link>
            </div>
            {article.tastingScores && (
              <div className="text-right">
                <p className="text-2xl font-bold text-amber-700">
                  {(() => {
                    const scores = article.tastingScores as Record<string, number>;
                    const vals = Object.values(scores);
                    return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : "-";
                  })()}
                </p>
                <p className="text-xs text-stone-400">综合评分</p>
              </div>
            )}
          </div>
        )}

        {/* Tasting scores detail */}
        {article.tastingScores && (
          <div className="grid grid-cols-3 md:grid-cols-5 gap-2 mt-4">
            {Object.entries(article.tastingScores as Record<string, number>).map(([key, val]) => (
              <div key={key} className="text-center p-2 bg-stone-50 rounded-lg">
                <div className="text-xs text-stone-400">{key}</div>
                <div className="text-lg font-bold text-amber-700">{val}</div>
              </div>
            ))}
          </div>
        )}

        {/* Brew info */}
        {(article.brewMethod || article.waterTemp || article.teaWeight || article.steepCount) && (
          <div className="flex flex-wrap gap-4 mt-4 text-sm text-stone-500">
            {article.brewMethod && <span>冲泡: {article.brewMethod}</span>}
            {article.waterTemp && <span>水温: {article.waterTemp}°C</span>}
            {article.teaWeight && <span>投茶: {article.teaWeight}</span>}
            {article.steepCount && <span>耐泡: {article.steepCount}泡</span>}
          </div>
        )}

        {/* Content */}
        <ForumContent html={article.content} className="mt-6" />

        {/* Actions: like + favorite + share */}
        <div className="flex items-center gap-4 mt-6 pt-4 border-t border-stone-100">
          <LikeButton articleId={id} initialLiked={initialLiked} initialCount={article._count.likes} />
          <FavoriteButton articleId={id} initialFavorited={initialFavorited} />
          <ShareButton title={article.title} url={shareUrl} />
        </div>
      </article>

      {/* Comments */}
      <CommentSection articleId={id} />
    </div>
  );
}
