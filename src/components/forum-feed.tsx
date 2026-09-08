"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import VoteButton from "@/components/vote-button";
import VideoPlayer from "@/components/video-player";
import AuthorHover from "@/components/author-hover";
import FollowThreadButton from "@/components/follow-thread-button";
import { getFlair } from "@/lib/forum-constants";

// ── Read tracking ──────────────────────────────────────────────
const STORAGE_KEY = "puer_seen_posts";

function getSeenPosts(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

function markSeen(id: string) {
  try {
    const seen = getSeenPosts();
    seen.add(id);
    // Keep only last 200 to prevent localStorage from growing too large
    const arr = Array.from(seen).slice(-200);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch {}
}

interface FeedArticle {
  id: string;
  title: string;
  upvotes: number;
  downvotes: number;
  replyCount: number;
  createdAt: string;
  isEssence: boolean;
  isPinned: boolean;
  content: string;
  coverImage?: string | null;
  images?: string[];
  videoUrl?: string | null;
  flair: string | null;
  board: { slug: string; name: string } | null;
  author: { id: string; username: string; avatar: string | null; level: number; followerCount: number; karma: number };
  initialVote: number;
}

interface Board {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
}

interface ForumFeedProps {
  articles: FeedArticle[];
  boards: Board[];
  currentUserId?: string;
  tab: string;
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(dateStr).toLocaleDateString("zh-CN");
}

const TABS = [
  { key: "hot", label: "🔥 热榜" },
  { key: "latest", label: "⏰ 最新" },
  { key: "essence", label: "💎 精华" },
];

export default function ForumFeed({ articles, boards, currentUserId, tab }: ForumFeedProps) {
  const [mounted, setMounted] = useState(false);
  // Read tracking: reorder to prioritize unseen posts
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const [orderedArticles, setOrderedArticles] = useState(articles);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const s = getSeenPosts();
    setSeen(s);
    // Reorder: unseen first (within each score tier), then seen
    const sorted = [...articles].sort((a, b) => {
      const aSeen = s.has(a.id);
      const bSeen = s.has(b.id);
      if (aSeen !== bSeen) return aSeen ? 1 : -1;
      return 0; // preserve original order within each group
    });
    setOrderedArticles(sorted);
  }, [articles]);

  // Track seen items via intersection observer
  const seenTrackerRef = useRef<IntersectionObserver | null>(null);
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());

  useEffect(() => {
    seenTrackerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute("data-article-id");
            if (id) {
              markSeen(id);
              if (!seen.has(id)) {
                setSeen((prev) => { const next = new Set(prev); next.add(id); return next; });
              }
            }
          }
        }
      },
      { threshold: 0.3, rootMargin: "200px" }
    );
    return () => seenTrackerRef.current?.disconnect();
  }, [seen]);

  return (
    <>
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-stone-200 mb-3">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/forum?tab=${t.key}`}
            className={`px-3 py-2.5 text-sm font-medium border-b-2 transition -mb-px min-h-[44px] flex items-center ${
              tab === t.key
                ? "border-amber-700 text-amber-900"
                : "border-transparent text-stone-500 hover:text-stone-700 hover:border-stone-300"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {/* Article feed */}
      {orderedArticles.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-stone-200 rounded-lg bg-white">
          <p className="text-stone-300 text-lg mb-1">
            {tab === "essence" ? "💎" : "📭"}
          </p>
          <p className="text-stone-500 text-sm">
            {tab === "essence" ? "还没有精华帖" : tab === "latest" ? "暂无最新帖子" : "暂无帖子"}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {orderedArticles.map((article) => (
            <div key={article.id} ref={(el) => { if (el && seenTrackerRef.current) seenTrackerRef.current.observe(el); }}>
              <ArticleCard article={article} currentUserId={currentUserId} isNew={mounted && !seen.has(article.id)} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ArticleCard({ article, currentUserId, isNew }: { article: FeedArticle; currentUserId?: string; isNew?: boolean }) {
  const [videoFailed, setVideoFailed] = useState(false);
  const effectiveVideoUrl = videoFailed ? null : article.videoUrl;
  const hasMedia = !!(effectiveVideoUrl || article.images?.length || article.coverImage);
  const flairDef = getFlair(article.flair);

  return (
    <div className="bg-white border border-stone-200 rounded-lg hover:border-stone-300 transition overflow-hidden relative">
      {/* Top: title + metadata row */}
      <div className="flex gap-2 md:gap-3 px-3 pt-2.5 pb-2 md:px-4 md:pt-3 md:pb-2">
        {/* Vote column */}
        <div className="shrink-0 pt-0.5">
          <VoteButton
            refId={article.id}
            type="article"
            initialUpvotes={article.upvotes}
            initialDownvotes={article.downvotes}
            initialValue={article.initialVote}
            size="sm"
          />
        </div>

        {/* Content column */}
        <div className="min-w-0 flex-1">
          {/* Title row */}
          <div className="flex items-start gap-1.5 mb-0.5">
            <Link
              href={`/forum/thread/${article.id}`}
              className="text-sm md:text-base font-semibold text-stone-800 hover:text-amber-800 leading-snug line-clamp-2"
            >
              {article.title}
            </Link>
            {isNew && (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 bg-green-500 text-white rounded-full font-medium mt-[3px]">新</span>
            )}
            {flairDef && (
              <span className={`shrink-0 inline-flex items-center px-1.5 py-0.5 text-[10px] leading-none font-medium rounded-full mt-[3px] ${flairDef.color}`}>
                {flairDef.label}
              </span>
            )}
            {article.isEssence && (
              <span className="shrink-0 text-xs mt-0.5" title="精华">⭐</span>
            )}
            {article.isPinned && (
              <span className="shrink-0 text-xs mt-0.5" title="置顶">📌</span>
            )}
          </div>

          {/* Metadata + follow */}
          <div className="flex items-center gap-1.5 text-xs text-stone-500 flex-wrap">
            {article.board && (
              <>
                <Link href={`/forum/${article.board.slug}`} className="text-stone-500 hover:text-amber-700 font-medium">
                  {article.board.name}
                </Link>
                <span>·</span>
              </>
            )}
            <AuthorHover
              author={{
                id: article.author.id,
                username: article.author.username,
                avatar: article.author.avatar,
                level: article.author.level,
                bio: null,
                teaAge: null,
                createdAt: article.createdAt,
                karma: article.author.karma,
                followerCount: article.author.followerCount,
              }}
            />
            <span>·</span>
            <span suppressHydrationWarning>{timeAgo(article.createdAt)}</span>
            {article.replyCount > 0 && (
              <>
                <span>·</span>
                <Link href={`/forum/thread/${article.id}`} className="hover:text-stone-600">
                  {article.replyCount} 条评论
                </Link>
              </>
            )}
            <div className="ml-auto">
              <FollowThreadButton articleId={article.id} />
            </div>
          </div>
        </div>
      </div>

      {/* Media preview — 4:3 aspect ratio */}
      {effectiveVideoUrl && (
        <div className="border-t border-stone-100 bg-black aspect-[4/3]">
          <VideoPlayer src={effectiveVideoUrl} onVideoError={() => setVideoFailed(true)} />
        </div>
      )}
      {!effectiveVideoUrl && article.images && article.images.length > 0 && (
        <ImageCarousel images={article.images} articleId={article.id} />
      )}
      {!effectiveVideoUrl && article.coverImage && (!article.images || article.images.length === 0) && (
        <Link href={`/forum/thread/${article.id}`} className="block border-t border-stone-100 bg-stone-50">
          <div className="aspect-[4/3]">
            <img src={article.coverImage} alt="" decoding="async" loading="lazy" className="w-full h-full object-cover" />
          </div>
        </Link>
      )}

      {/* Text preview (only when no media) */}
      {!hasMedia && article.content && (
        <div className="px-3 pb-2.5 md:px-4 md:pb-3">
          <p className="text-xs text-stone-500 leading-relaxed line-clamp-2">{article.content}</p>
        </div>
      )}
    </div>
  );
}

/** Image carousel with auto-play (pauses on hover) and manual navigation */
function ImageCarousel({ images, articleId }: { images: string[]; articleId: string }) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);

  // Auto-play: advance every 3s, pause on hover or manual interaction
  useEffect(() => {
    if (images.length <= 1 || paused) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % images.length), 3000);
    return () => clearInterval(t);
  }, [images.length, paused]);

  const prev = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPaused(true);
    setIdx((i) => (i > 0 ? i - 1 : images.length - 1));
    setTimeout(() => setPaused(false), 6000);
  }, [images.length]);

  const next = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPaused(true);
    setIdx((i) => (i < images.length - 1 ? i + 1 : 0));
    setTimeout(() => setPaused(false), 6000);
  }, [images.length]);

  const goTo = useCallback((e: React.MouseEvent, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    setPaused(true);
    setIdx(i);
    setTimeout(() => setPaused(false), 6000);
  }, []);

  return (
    <Link href={`/forum/thread/${articleId}`} className="block border-t border-stone-100 bg-stone-50 relative"
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="aspect-[4/3] relative overflow-hidden">
        {/* 只渲染当前图片:避免一次性加载帖子全部图片(原 map 渲染所有 img 用 opacity 切换,导致每帖N图全加载)。
            下一张用隐藏 img 预加载,使轮播切换更流畅。 */}
        <img key={idx} src={images[idx]} alt="" decoding="async" loading="lazy"
          className="absolute inset-0 w-full h-full object-cover" />
        {images.length > 1 && (
          <img src={images[(idx + 1) % images.length]} alt="" aria-hidden="true" loading="lazy"
            className="absolute inset-0 w-full h-full object-cover opacity-0 pointer-events-none" />
        )}
        {/* Nav arrows */}
        {images.length > 1 && (
          <>
            <button onClick={prev} className="absolute left-1 top-1/2 -translate-y-1/2 w-7 h-7 bg-black/30 hover:bg-black/50 text-white rounded-full flex items-center justify-center text-sm transition z-10">&lsaquo;</button>
            <button onClick={next} className="absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7 bg-black/30 hover:bg-black/50 text-white rounded-full flex items-center justify-center text-sm transition z-10">&rsaquo;</button>
          </>
        )}
      </div>
      {/* Dots + counter */}
      {images.length > 1 && (
        <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 z-10">
          {images.map((_, i) => (
            <button key={i} onClick={(e) => goTo(e, i)}
              className={`rounded-full transition-all ${i === idx ? "w-3 h-1.5 bg-white" : "w-1.5 h-1.5 bg-white/40"}`} />
          ))}
          <span className="text-[10px] text-white/70 ml-1 tabular-nums">{idx + 1}/{images.length}</span>
        </div>
      )}
    </Link>
  );
}
