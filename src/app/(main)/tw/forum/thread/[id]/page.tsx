/**
 * /tw/forum/thread/[id] — Traditional Chinese mirror of /forum/thread/[id].
 *
 * Same DB, same Prisma SELECT, same child components — only the visible text
 * (title/summary/content/breadcrumb labels) is run through s2t conversion.
 * canonical stays on /forum/thread/[id] (the authoritative SC version).
 * JSON-LD on this page is limited to BreadcrumbList; Article/VideoObject are
 * kept on the SC page only (Google recommends structured data live on the
 * canonical, not on language alternates).
 */
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { canViewArticleDetail } from "@/lib/article-visibility";
import { safeJsonLdStringify } from "@/lib/json-ld";
import { firstImageFromHtml } from "@/lib/seo-image";
import { convertText, convertPostHtml } from "@/lib/s2t";
import { twHref } from "@/i18n/translations";
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
import ArticleImageGallery from "@/components/article-image-gallery";
import VideoPlayer from "@/components/video-player";
import DeleteThreadButton from "@/components/delete-thread-button";
import PromoteHomeButton from "@/components/promote-home-button";
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
    select: { title: true, content: true, summary: true, tags: true, videoUrl: true, images: true, status: true, visibility: true, authorId: true, createdAt: true, updatedAt: true, author: { select: { username: true } } },
  });
  const session = await auth();
  const viewable =
    !!article &&
    canViewArticleDetail(
      { status: article.status, visibility: article.visibility, authorId: article.authorId },
      { userId: session?.user?.id, isAdmin: session?.user?.role === "admin" },
    );
  if (!article || !viewable) {
    return { title: convertText("帖子不可见"), robots: { index: false, follow: false } };
  }
  const desc = article.summary || article.content.replace(/<[^>]*>/g, "").slice(0, 160) || "查看帖子詳情";
  // Convert metadata text for TW SERP snippet. description comes from summary
  // or content (HTML-stripped); we convert either way so users searching in TW
  // see a TW snippet.
  const twTitle = convertText(article.title);
  const twDesc = convertText(desc);
  const coverImage = firstImageFromHtml(article.content) || article.images?.[0] || null;
  const og: Record<string, unknown> = {
    title: twTitle,
    description: twDesc,
    type: "article",
    // Explicit, or the TW document inherits Next's `zh_CN` default and
    // contradicts its own hreflang cluster.
    locale: "zh_TW",
    publishedTime: article.createdAt.toISOString(),
    modifiedTime: article.updatedAt.toISOString(),
    authors: [article.author.username],
  };
  if (coverImage) og.images = [{ url: coverImage, width: 1200, height: 630, alt: twTitle }];
  const titleWords = article.title.split(/[\s,，、]+/).filter(Boolean).slice(0, 5);
  return {
    title: twTitle,
    description: twDesc,
    // Keywords are display-only (Google has ignored meta keywords since 2009),
    // but a TW document should not carry SC glyphs in it either. Unlike the
    // title/description above, this field is an array, so convertText has to be
    // mapped over it — titleWords and tags both come straight from the SC record.
    keywords: [...titleWords, ...(article.tags || []), "普洱茶", "品茶"].map(convertText),
    alternates: {
      // Canonical points to SC (DB-authoritative copy).
      canonical: `/forum/thread/${id}`,
      languages: {
        "zh-Hans-CN": `/forum/thread/${id}`,
        "zh-Hant-TW": `/tw/forum/thread/${id}`,
        "x-default": `/forum/thread/${id}`,
      },
    },
    openGraph: og,
  };
}

export default async function TwThreadPage({ params }: PageProps) {
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

  const viewable =
    !!article &&
    canViewArticleDetail(
      { status: article.status, visibility: article.visibility, authorId: article.authorId },
      { userId: session?.user?.id, isAdmin: session?.user?.role === "admin" },
    );
  if (!article || !viewable) {
    notFound();
  }

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

  const authorPostCount = await prisma.article.count({
    where: { authorId: article.author.id, status: "published" },
  });

  await prisma.article.update({ where: { id }, data: { viewCount: { increment: 1 } } });

  const canModerate = !!(session?.user?.role === "admin" || (session?.user && article.board?.id && (
    await prisma.boardModerator.findUnique({
      where: { boardId_userId: { boardId: article.board.id, userId: session.user.id } },
    }).catch(() => null)
  )?.status === "approved"));
  const flairDef = getFlair(article.flair);
  // P2-R26：茶记帖图片墙 — article.images 中未内联进 content 的部分
  const inlineSrcs = new Set(Array.from(article.content.matchAll(/<img[^>]+src="([^">]+)"/g)).map((m) => m[1]));
  const galleryImages = (article.images ?? []).filter((u) => !inlineSrcs.has(u));

  // Convert everything visible. Author/nickname/board are not converted
  // (proper nouns / DB identifiers). UI chrome ("帖子"/"編輯" etc.) is left to
  // the existing I18nProvider + zhCNtoTW map for Phase 1.
  const twTitle = convertText(article.title);
  const twContent = convertPostHtml(article.content);
  const twBoardName = article.board ? convertText(article.board.name) : null;
  const twFlairLabel = flairDef ? convertText(flairDef.label) : null;

  return (
    <div className="max-w-4xl mx-auto px-3 md:px-6 py-4 md:py-8">
      {/* BreadcrumbList JSON-LD — only structured data on /tw/ pages.
          Article/VideoObject stay on the SC canonical. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLdStringify({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            inLanguage: "zh-TW",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: convertText("首頁"), item: "https://puer.im" },
              { "@type": "ListItem", position: 2, name: convertText("論壇"), item: "https://puer.im/forum" },
              ...(article.board
                ? [{ "@type": "ListItem", position: 3, name: twBoardName ?? article.board.name, item: `https://puer.im/forum/${article.board.slug}` }]
                : []),
              { "@type": "ListItem", position: article.board ? 4 : 3, name: twTitle, item: `https://puer.im/forum/thread/${id}` },
            ],
          }),
        }}
      />
      {/* Breadcrumb */}
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href={twHref("zh-TW", "/forum")} className="hover:text-stone-600 transition">{convertText("論壇")}</Link>
        {article.board && (
          <>
            <span className="mx-1.5">/</span>
            {/* twHref, not a hand-built `/tw/...` literal: a board whose slug
                has no mirror (e.g. `classics`, which is the curated landing
                page on the SC side) must stay unprefixed, and that rule lives
                in one place. */}
            <Link href={twHref("zh-TW", `/forum/${article.board.slug}`)} className="hover:text-stone-600 transition">
              {twBoardName}
            </Link>
          </>
        )}
      </nav>

      <article className="bg-white border border-stone-200 rounded-lg overflow-hidden">
        <div className="p-4 md:p-6">
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
            <span>發表於 {new Date(article.createdAt).toLocaleString("zh-TW")}</span>
          </div>

          {(article.isEssence || article.isPinned || flairDef) && (
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              {flairDef && twFlairLabel && (
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${flairDef.color}`}>
                  {twFlairLabel}
                </span>
              )}
              {article.isEssence && (
                <span className="text-xs px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded font-medium">{convertText("精華")}</span>
              )}
              {article.isPinned && (
                <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded font-medium">{convertText("置頂")}</span>
              )}
            </div>
          )}

          <h1 className="text-xl md:text-2xl font-bold text-stone-800 mb-4 leading-snug">
            {twTitle}
          </h1>

          <ForumContent html={twContent} />

          <ArticleImageGallery images={galleryImages} />

          {article.videoUrl && (
            <div className="mt-4 -mx-2">
              <VideoPlayer src={article.videoUrl} />
            </div>
          )}

          <div className="mt-6 pt-4 border-t border-stone-200 space-y-3">
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
              <ShareButton title={twTitle} url={threadUrl} />
              <FollowThreadButton articleId={id} />
            </div>

            <div className="flex items-center gap-3 text-xs text-stone-400">
              <span>{article.viewCount} {convertText("次查看")} · {article._count.comments} {convertText("條回覆")}</span>
              <span className="flex-1" />
              <ReportButton targetType="article" targetId={id} />
              {session?.user && (session.user.id === article.author.id || session.user.role === "admin") && (
                <>
                  <Link
                    href={`/forum/thread/${article.id}/edit`}
                    className="px-2.5 py-1.5 border border-stone-300 text-stone-600 rounded hover:bg-stone-50 transition"
                  >
                    {convertText("編輯")}
                  </Link>
                  {article.board && (
                    <DeleteThreadButton articleId={article.id} boardSlug={article.board.slug} />
                  )}
                </>
              )}
              {article.board?.slug === "classics" && article.teaId && session?.user &&
                (session.user.id === article.author.id || session.user.role === "admin" || session.user.level >= 3) && (
                <PromoteHomeButton
                  boardSlug={article.board.slug}
                  articleId={article.id}
                  initialPromoted={!!article.promotedHomeAt}
                />
              )}
            </div>
          </div>

          {canModerate && article.board && (
            <div className="flex items-center gap-3 mt-4 pt-4 border-t border-stone-200">
              <ModerateButton boardSlug={article.board.slug} articleId={id} action="pin" initialLabel={article.isPinned ? convertText("取消置頂") : convertText("置頂")} />
              <ModerateButton boardSlug={article.board.slug} articleId={id} action="essence" initialLabel={article.isEssence ? convertText("取消精華") : convertText("精華")} />
            </div>
          )}
        </div>
      </article>

      <CommentSection articleId={id} articleAuthorId={article.author.id} />
    </div>
  );
}
