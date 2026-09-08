import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { canViewArticleDetail } from "@/lib/article-visibility";
import { safeJsonLdStringify } from "@/lib/json-ld";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import LikeButton from "@/components/like-button";
import FavoriteButton from "@/components/favorite-button";
import ShareButton from "@/components/share-button";
import VoteButton from "@/components/vote-button";
import AuthorHover from "@/components/author-hover";
import CommentSection from "@/components/comment-section";
import ModerateButton from "@/components/moderate-button";
import ForumContent from "@/components/forum-content";
import VideoPlayer from "@/components/video-player";
import DeleteThreadButton from "@/components/delete-thread-button";
import FollowThreadButton from "@/components/follow-thread-button";
import ReportButton from "@/components/report-button";
import MessageButton from "@/components/message-button";
import { getFlair } from "@/lib/forum-constants";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const article = await prisma.article.findUnique({
    where: { id },
    select: { title: true, content: true, summary: true, tags: true, videoUrl: true, status: true, visibility: true, authorId: true, createdAt: true, updatedAt: true, author: { select: { username: true } } },
  });
  const session = await auth();
  const viewable =
    !!article &&
    canViewArticleDetail(
      { status: article.status, visibility: article.visibility, authorId: article.authorId },
      { userId: session?.user?.id, isAdmin: session?.user?.role === "admin" },
    );
  // Hidden (missing, draft, pending, private, archived, or unknown status):
  // emit no real title/description/OG and tell crawlers not to index. The page
  // body separately returns notFound(), so no content leaks either.
  if (!article || !viewable) {
    return { title: "帖子不可见", robots: { index: false, follow: false } };
  }
  const desc = article.summary || article.content.replace(/<[^>]*>/g, "").slice(0, 160) || "查看帖子详情";
  let coverImage = article.content.match(/<img[^>]+src="([^">]+)"/)?.[1] || null;
  if (coverImage) coverImage = coverImage.replace(/^https?:\/\/localhost:\d+/, "https://puer.im").replace(/^\/\//, "https://").replace(/^\/(uploads)/, "https://puer.im/$1");
  const og: Record<string, unknown> = {
    title: article.title,
    description: desc,
    type: "article",
    publishedTime: article.createdAt.toISOString(),
    modifiedTime: article.updatedAt.toISOString(),
    authors: [article.author.username],
  };
  if (coverImage) og.images = [{ url: coverImage, width: 1200, height: 630, alt: article.title }];
  const titleWords = article.title.split(/[\s,，、]+/).filter(Boolean).slice(0, 5);
  return {
    title: article.title,
    description: desc,
    keywords: [...titleWords, ...(article.tags || []), "普洱茶", "品茶"],
    alternates: { canonical: `/forum/thread/${id}` },
    openGraph: og,
  };
}

export default async function ThreadPage({ params }: PageProps) {
  const { id } = await params;
  const session = await auth();
  const headersList = await headers();
  const host = headersList.get("host") || "puer.im";
  const threadUrl = `http${host.includes("localhost") ? "" : "s"}://${host}/forum/thread/${id}`;

  const article = await prisma.article.findUnique({
    where: { id },
    include: {
      author: {
        select: {
          id: true, username: true, nickname: true, avatar: true, level: true,
          bio: true, teaAge: true, createdAt: true, registrationRegion: true,
          karma: true, followerCount: true,
        },
      },
      board: { select: { id: true, name: true, slug: true } },
      _count: { select: { comments: true, likes: true, favorites: true } },
    },
  }).catch(() => null);

  // Detail-level visibility, fail-closed (same policy as the API GET and
  // generateMetadata). Checked BEFORE incrementing viewCount so a hidden
  // article never records a view from a disallowed visitor.
  const viewable =
    !!article &&
    canViewArticleDetail(
      { status: article.status, visibility: article.visibility, authorId: article.authorId },
      { userId: session?.user?.id, isAdmin: session?.user?.role === "admin" },
    );
  if (!article || !viewable) {
    notFound();
  }

  // Check initial like/favorite/vote state for current user
  let initialLiked = false;
  let initialFavorited = false;
  let initialVote = 0;
  if (session?.user) {
    const [like, fav, vote] = await Promise.all([
      prisma.like.findUnique({
        where: { userId_type_refId: { userId: session.user.id, type: "article", refId: id } },
      }),
      prisma.favorite.findUnique({
        where: { userId_articleId: { userId: session.user.id, articleId: id } },
      }),
      prisma.vote.findUnique({
        where: { userId_refId: { userId: session.user.id, refId: id } },
      }),
    ]);
    initialLiked = !!like;
    initialFavorited = !!fav;
    if (vote) initialVote = vote.value;
  }

  // Author post count (for hover card)
  const authorPostCount = await prisma.article.count({
    where: { authorId: article.author.id, status: "published" },
  });

  // Increment view count
  await prisma.article.update({ where: { id }, data: { viewCount: { increment: 1 } } });

  const canModerate = !!(session?.user?.role === "admin" || (session?.user && article.board?.id && (
    await prisma.boardModerator.findUnique({
      where: { boardId_userId: { boardId: article.board.id, userId: session.user.id } },
    }).catch(() => null)
  )?.status === "approved"));
  const flairDef = getFlair(article.flair);

  return (
    <div className="max-w-4xl mx-auto px-3 md:px-6 py-4 md:py-8">
      {/* Article JSON-LD */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLdStringify({
            "@context": "https://schema.org",
            "@type": "Article",
            headline: article.title,
            datePublished: article.createdAt.toISOString(),
            dateModified: article.updatedAt.toISOString(),
            author: { "@type": "Person", name: article.author.username },
            publisher: { "@type": "Organization", name: "Puêr", url: "https://puer.im" },
            url: `https://puer.im/forum/thread/${id}`,
            description: article.summary || article.content.replace(/<[^>]*>/g, "").slice(0, 200),
          }),
        }}
      />
      {/* BreadcrumbList JSON-LD */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLdStringify({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "首页", item: "https://puer.im" },
              { "@type": "ListItem", position: 2, name: "论坛", item: "https://puer.im/forum" },
              ...(article.board
                ? [{ "@type": "ListItem", position: 3, name: article.board.name, item: `https://puer.im/forum/${article.board.slug}` }]
                : []),
              { "@type": "ListItem", position: article.board ? 4 : 3, name: article.title, item: `https://puer.im/forum/thread/${id}` },
            ],
          }),
        }}
      />
      {/* Breadcrumb */}
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-stone-600 transition">论坛</Link>
        {article.board && (
          <>
            <span className="mx-1.5">/</span>
            <Link href={`/forum/${article.board.slug}`} className="hover:text-stone-600 transition">
              {article.board.name}
            </Link>
          </>
        )}
      </nav>

      {/* ─── Post ─────────────────────────── */}
      <article className="bg-white border border-stone-200 rounded-lg overflow-hidden">
        <div className="p-4 md:p-6">
          {/* Author line */}
          <div className="flex items-center gap-2 text-xs text-stone-400 mb-3 flex-wrap">
            <AuthorHover
              author={{
                id: article.author.id,
                username: article.author.username,
                avatar: article.author.avatar,
                level: article.author.level,
                bio: article.author.bio,
                teaAge: article.author.teaAge,
                createdAt: article.author.createdAt.toISOString(),
                postCount: authorPostCount,
                karma: article.author.karma,
                followerCount: article.author.followerCount,
                registrationRegion: article.author.registrationRegion,
              }}
            />
            <MessageButton targetId={article.author.id} targetName={article.author.nickname || article.author.username} />
            <span className="text-stone-300">·</span>
            <span className="font-mono">#1</span>
            <span className="text-stone-300">·</span>
            <span>发表于 {new Date(article.createdAt).toLocaleString("zh-CN")}</span>
          </div>

          {/* Badges */}
          {(article.isEssence || article.isPinned || flairDef) && (
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              {flairDef && (
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${flairDef.color}`}>
                  {flairDef.label}
                </span>
              )}
              {article.isEssence && (
                <span className="text-xs px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded font-medium">精华</span>
              )}
              {article.isPinned && (
                <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded font-medium">置顶</span>
              )}
            </div>
          )}

          <h1 className="text-xl md:text-2xl font-bold text-stone-800 mb-4 leading-snug">
            {article.title}
          </h1>

          {/* Content */}
          <ForumContent html={article.content} />

          {/* Video embed */}
          {article.videoUrl && (
            <div className="mt-4 -mx-2">
              <VideoPlayer src={article.videoUrl} />
            </div>
          )}

          {/* Actions */}
          <div className="mt-6 pt-4 border-t border-stone-200 space-y-3">
            {/* Row 1: Primary actions */}
            <div className="flex items-center gap-2 md:gap-3">
              <VoteButton
                refId={id}
                type="article"
                initialUpvotes={article.upvotes}
                initialDownvotes={article.downvotes}
                initialValue={initialVote}
              />
              <LikeButton articleId={id} initialLiked={initialLiked} initialCount={article._count.likes} />
              <FavoriteButton articleId={id} initialFavorited={initialFavorited} />
              <ShareButton title={article.title} url={threadUrl} />
              <FollowThreadButton articleId={id} />
            </div>

            {/* Row 2: Stats + secondary actions */}
            <div className="flex items-center gap-3 text-xs text-stone-400">
              <span>{article.viewCount} 次查看 · {article._count.comments} 条回复</span>
              <span className="flex-1" />
              <ReportButton targetType="article" targetId={id} />
              {session?.user && (session.user.id === article.author.id || session.user.role === "admin") && (
                <>
                  <Link
                    href={`/forum/thread/${article.id}/edit`}
                    className="px-2.5 py-1.5 border border-stone-300 text-stone-600 rounded hover:bg-stone-50 transition"
                  >
                    编辑
                  </Link>
                  {article.board && (
                    <DeleteThreadButton articleId={article.id} boardSlug={article.board.slug} />
                  )}
                </>
              )}
            </div>
          </div>

          {/* Moderate actions */}
          {canModerate && article.board && (
            <div className="flex items-center gap-3 mt-4 pt-4 border-t border-stone-200">
              <ModerateButton boardSlug={article.board.slug} articleId={id} action="pin" initialLabel={article.isPinned ? "取消置顶" : "置顶"} />
              <ModerateButton boardSlug={article.board.slug} articleId={id} action="essence" initialLabel={article.isEssence ? "取消精华" : "精华"} />
            </div>
          )}
        </div>
      </article>

      {/* Comments / Replies */}
      <CommentSection articleId={id} articleAuthorId={article.author.id} />
    </div>
  );
}
