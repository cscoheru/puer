"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import VoteButton from "@/components/vote-button";
import VideoPlayer from "@/components/video-player";
import AuthorHover from "@/components/author-hover";
import FollowThreadButton from "@/components/follow-thread-button";
import { getFlair } from "@/lib/forum-constants";

// ── Read tracking ──────────────────────────────────────────────
const STORAGE_KEY = "puer_seen_posts";
const NEW_POST_MS = 48 * 3600_000; // "新"徽标：仅最近 48 小时内发布且用户未看过

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
    // Keep only last 400 to prevent localStorage from growing too large
    // （P2-R12：200→400，配合移动端已读降权拉长"不重复推荐"窗口）
    const arr = Array.from(seen).slice(-400);
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
  status: string; // P2-R24：pending_review 时显示「审核中」（仅作者本人可见）
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
  { key: "day", label: "🔥 今日" },
  { key: "week", label: "📅 本周" },
  { key: "month", label: "🏆 月榜" },
  { key: "latest", label: "⏰ 最新" },
  { key: "essence", label: "💎 精华" },
];

// ── 经典普洱卡片（P2-R2 / P2-R3）───────────────────────────────
// P2-R5：穿插卡片已移除（经典普洱退出首页信息流），入口改由移动端 header
// 「经典普洱」+ classics 页承担。

/** 帖子文字内容：默认折叠 3 行，可展开/收起（P2-R1：文字置于媒体之前） */
function CollapsibleText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const el = ref.current;
    setClamped(!!el && el.scrollHeight > el.clientHeight + 4);
  }, [text]);

  return (
    <div>
      <p
        ref={ref}
        className={`text-xs md:text-sm text-stone-600 leading-relaxed whitespace-pre-line ${expanded ? "" : "line-clamp-3"}`}
      >
        {text}
      </p>
      {clamped && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="text-xs text-amber-800 hover:text-amber-900 font-medium mt-0.5"
        >
          {expanded ? "收起 ▲" : "展开全文 ▼"}
        </button>
      )}
    </div>
  );
}

export default function ForumFeed({ articles, boards, currentUserId, tab }: ForumFeedProps) {
  const [mounted, setMounted] = useState(false);
  // Read tracking: reorder to prioritize unseen posts
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const [orderedBase, setOrderedBase] = useState(articles);
  // P2-R3 移动端懒加载：追加页数据。append-only——新页不与首屏重排，
  // 避免用户正在阅读的卡片因新数据到达而跳动。
  const [extraArticles, setExtraArticles] = useState<FeedArticle[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadGuardRef = useRef(false);
  // P2-R12 已读快照（进入页面时），供移动端加权降权
  const seenSnapshotRef = useRef<Set<string>>(new Set());
  // 服务端游标：SSR 首屏已消费 articles.length 条，从其后继续
  const loadedCountRef = useRef(articles.length);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const seen = getSeenPosts();
    setSeen(seen);
    // P2-R12：已读快照供移动端加权降权使用（固定为进入页面时的状态，
    // 阅读过程中新标记的已读不当场重排，避免正在看的卡片跳动）
    seenSnapshotRef.current = seen;
    // Reorder: unseen first (within each score tier), then seen
    const sorted = [...articles].sort((a, b) => {
      const aSeen = seen.has(a.id);
      const bSeen = seen.has(b.id);
      if (aSeen !== bSeen) return aSeen ? 1 : -1;
      return 0; // preserve original order within each group
    });
    setOrderedBase(sorted);
  }, [articles]);

  // P2-R16 已读降权·会话恢复：切 app 回来 / 黑屏点亮屏幕（visibilitychange
  // hidden→visible，离开 ≥10s 防误触电源键/下拉通知栏扰动）时刷新已读快照并重排——
  // 本次会话读过的沉底、没读的靠前。阅读中页面持续可见不会触发，不破坏
  // R12「阅读中卡片不跳动」设计；同组内稳定排序保持原有相对顺序。
  // P2-R17：重排时把懒加载追加页（extraArticles）一并并入首屏重排（此前追加页
  // 按服务端顺序 append，从不参与已读降权）；extraRef 供本 effect 读取最新值。
  const [reorderTick, setReorderTick] = useState(0);
  const hiddenAtRef = useRef<number | null>(null);
  const extraRef = useRef<FeedArticle[]>([]);
  const orderedBaseRef = useRef<FeedArticle[]>([]);
  useEffect(() => {
    extraRef.current = extraArticles;
  }, [extraArticles]);
  useEffect(() => {
    orderedBaseRef.current = orderedBase;
  }, [orderedBase]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
        return;
      }
      const awayMs = hiddenAtRef.current ? Date.now() - hiddenAtRef.current : Infinity;
      hiddenAtRef.current = null;
      if (awayMs < 10_000) return;
      seenSnapshotRef.current = getSeenPosts();
      const snap = seenSnapshotRef.current;
      const bySeen = (a: FeedArticle, b: FeedArticle) => {
        const aSeen = snap.has(a.id);
        const bSeen = snap.has(b.id);
        return aSeen === bSeen ? 0 : aSeen ? 1 : -1;
      };
      // 追加页并入首屏（按 id 去重）后统一 seen/unseen 分组重排
      const baseIds = new Set(orderedBaseRef.current.map((a) => a.id));
      const merged = [...orderedBaseRef.current, ...extraRef.current.filter((e) => !baseIds.has(e.id))];
      setOrderedBase(merged.sort(bySeen));
      setExtraArticles([]);
      // 移动端加权流：bump tick 使 items 依赖变化 → 按新快照重排
      setReorderTick((t) => t + 1);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // P2-R18 冷启动兜底：刷新后首屏卡片会被 observer 立即标记已读（rootMargin 预载区），
  // 但 mount 快照已拍、它们仍在「未读」组占据前排——尤其 R17 修复前的历史浏览无记录，
  // 大量用户认知中的"旧帖"实为系统未读。刷新 1.5s 后重拍快照并重排一次：
  // 首屏刚标记的旧帖立即沉底，"旧帖回前"现象逐次消失（记录随浏览自然积累）。
  // P2-R19：重排时把已加载的追加页（extraArticles）一并并入首屏分组——
  // 首屏加载快、1.5s 时追加页已到达的场景，追加页同样需要已读沉底。
  useEffect(() => {
    const t = setTimeout(() => {
      seenSnapshotRef.current = getSeenPosts();
      const snap = seenSnapshotRef.current;
      const bySeen = (a: FeedArticle, b: FeedArticle) => {
        const aSeen = snap.has(a.id);
        const bSeen = snap.has(b.id);
        return aSeen === bSeen ? 0 : aSeen ? 1 : -1;
      };
      const baseIds = new Set(orderedBaseRef.current.map((a) => a.id));
      const merged = [...orderedBaseRef.current, ...extraRef.current.filter((e) => !baseIds.has(e.id))];
      setOrderedBase(merged.sort(bySeen));
      setExtraArticles([]);
      setReorderTick((tick) => tick + 1);
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  // P2-R3 移动端检测：桌面（lg+）保持三栏 + 五 tab；移动端切单一加权推荐流
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // P2-R3 综合加权：热度位次 × 0.5 + 新鲜度 × 0.3 + 互动率 × 0.2；
  // 桌面端维持服务端 tab 排序不变。
  // 首屏（orderedBase）参与加权排序；懒加载追加页按服务端顺序接在后面。
  // P2-R5：经典普洱不再穿插移动端信息流（跟进帖与茶品卡片均移除，
  // 入口改由 header「经典普洱」承担），feed 只渲染帖子。
  const items = useMemo<FeedArticle[]>(() => {
    // P2-R10：桌面也启用懒加载归档续读——extraArticles 必须拼进桌面列表
    // （此前仅移动端拼接，桌面拉回的数据被丢弃，导致"到底了"但列表不变）。
    if (!isMobile) return [...orderedBase, ...extraArticles];
    const now = Date.now();
    const scored = orderedBase.map((a, rank) => {
      const posScore = 1 - rank / Math.max(1, orderedBase.length); // 服务端热榜位次
      const ageH = (now - new Date(a.createdAt).getTime()) / 3600_000;
      const fresh = Math.exp(-ageH / 72); // ~3 天量级的新鲜度衰减
      const engageRaw = a.upvotes + 2 * a.replyCount + 1;
      const engage = engageRaw / (engageRaw + 8); // 平滑互动率 0..1
      const s = 0.5 * posScore + 0.3 * fresh + 0.2 * engage;
      return { data: a, s };
    });
    // P2-R17 已读两级分组（替代 R12 的 ×0.35 柔性降权——热帖降权后仍可能压住
    // 未读帖，用户感知"排序没变"）：未读组在前、已读组整组沉底，组内按推荐分。
    // 看过的帖子绝不排在未读之前；记忆仅 localStorage 最近 400 条，超出自然遗忘。
    const snap = seenSnapshotRef.current;
    scored.sort((x, y) => {
      const xs = snap.has(x.data.id) ? 1 : 0;
      const ys = snap.has(y.data.id) ? 1 : 0;
      if (xs !== ys) return xs - ys;
      return y.s - x.s;
    });
    return [...scored.map((e) => e.data), ...extraArticles];
    // reorderTick：P2-R16 会话恢复（切 app 回来/点亮屏幕）时按新已读快照重排
  }, [orderedBase, extraArticles, isMobile, reorderTick]);

  // Track seen items via intersection observer
  // P2-R17 修复：① 卡片容器补 data-article-id（此前缺失导致 getAttribute 恒为
  // null，markSeen 从未执行——已读降权/「新」徽章失灵的根因）；② observer 生命周期
  // 与 seen 解耦（旧实现依赖 [seen]，每次标记都 disconnect 重建，已渲染卡片不会
  // 重新挂上新 observer，观察链路标记一次即断死）。现改为永生 observer + 函数式
  // setSeen（引用相等时 React 自动 bail out，不触发多余渲染）。
  const seenTrackerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    seenTrackerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute("data-article-id");
            if (id) {
              markSeen(id);
              setSeen((prev) => {
                if (prev.has(id)) return prev;
                const next = new Set(prev);
                next.add(id);
                return next;
              });
            }
          }
        }
      },
      { threshold: 0.3, rootMargin: "200px" }
    );
    return () => seenTrackerRef.current?.disconnect();
  }, []);

  // P2-R3 懒加载：滚动接近底部时拉取下一页（仅移动端）。热榜窗口耗尽后
  // 服务端自动续读更早的归档帖，保证一直有内容可刷。
  const loadMore = useCallback(async () => {
    if (loadGuardRef.current || !hasMore) return;
    loadGuardRef.current = true;
    setLoadingMore(true);
    try {
      const offset = loadedCountRef.current;
      const res = await fetch(`/api/forum/feed?tab=${encodeURIComponent(tab)}&offset=${offset}&limit=10`);
      if (!res.ok) throw new Error("feed fetch failed");
      const d = (await res.json()) as { articles?: FeedArticle[]; hasMore?: boolean };
      const incoming = d.articles || [];
      // 服务端游标按服务端返回条数推进（含客户端去重掉的重复项）
      loadedCountRef.current = offset + incoming.length;
      const existing = new Set([...orderedBase, ...extraArticles].map((a) => a.id));
      const fresh = incoming.filter((a) => !existing.has(a.id));
      if (fresh.length > 0) setExtraArticles((prev) => [...prev, ...fresh]);
      if (!d.hasMore || incoming.length === 0) setHasMore(false);
    } catch {
      setHasMore(false);
    } finally {
      loadGuardRef.current = false;
      setLoadingMore(false);
    }
  }, [tab, hasMore, orderedBase, extraArticles]);

  // P2-R10：懒加载不再限移动端——桌面端热榜窗口（质量门槛）耗尽后
  // 同样需要归档续读，否则首屏仅几条（如 week 窗口）就"拉不到底"。
  useEffect(() => {
    if (!hasMore || !mounted) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) void loadMore(); },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, mounted, loadMore]);

  return (
    <>
      {/* Tab bar（桌面 lg+ 五 tab；移动端为无头部的混合推荐流，
          滚动到底部自动懒加载更多） */}
      <div className="hidden lg:flex items-center gap-1 border-b border-stone-200 mb-3">
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
      {items.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-stone-200 rounded-lg bg-white">
          <p className="text-stone-300 text-lg mb-1">
            {tab === "essence" ? "💎" : "📭"}
          </p>
          <p className="text-stone-500 text-sm">
            {tab === "essence"
              ? "还没有精华帖"
              : tab === "latest"
                ? "暂无最新帖子"
                : tab === "day"
                  ? "今天还没有帖子，看看本周热榜吧"
                  : "暂无帖子"}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {items.map((article) => (
            <div key={article.id} data-article-id={article.id} ref={(el) => { if (el && seenTrackerRef.current) seenTrackerRef.current.observe(el); }}>
              <ArticleCard
                article={article}
                currentUserId={currentUserId}
                isNew={mounted && !seen.has(article.id) && Date.now() - new Date(article.createdAt).getTime() < NEW_POST_MS}
              />
            </div>
          ))}
          {/* 懒加载哨兵：进入视口即拉取下一页（P2-R10 起桌面/移动通用） */}
          {items.length > 0 && (
            <div ref={sentinelRef} className="py-6 text-center text-xs text-stone-400">
              {loadingMore ? "正在加载更多…" : hasMore ? "上滑/滚动加载更多 ↓" : "— 到底了，去经典普洱茶吧逛逛 —"}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function ArticleCard({ article, currentUserId, isNew }: { article: FeedArticle; currentUserId?: string; isNew?: boolean }) {
  const [videoFailed, setVideoFailed] = useState(false);
  const effectiveVideoUrl = videoFailed ? null : article.videoUrl;
  const flairDef = getFlair(article.flair);

  return (
    <div className="bg-white border border-stone-200 rounded-lg hover:border-stone-300 transition overflow-hidden relative flex flex-col">
      {/* P2-R9 Reddit/X 式卡片：作者行 → 标题 → 正文 → 媒体 → 底部操作行
          （原左列投票压缩标题宽度、元信息 flex-wrap 换行留白，移动端观感差） */}
      <div className="px-3 pt-2.5 pb-1.5 md:px-4 md:pt-3">
        {/* 行1：头像 - 作者 - 时间 - 版块 - 徽标 */}
        <div className="flex items-center gap-2 mb-1.5 min-w-0">
          <Link href={`/user/${article.author.id}`} className="shrink-0">
            {article.author.avatar ? (
              <img src={article.author.avatar} alt="" loading="lazy" className="w-8 h-8 rounded-full object-cover" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 font-bold text-sm">
                {article.author.username[0]}
              </div>
            )}
          </Link>
          <div className="flex items-center gap-1.5 text-xs text-stone-500 min-w-0 flex-wrap">
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
            <span aria-hidden>·</span>
            <span suppressHydrationWarning>{timeAgo(article.createdAt)}</span>
            {article.board && (
              <>
                <span aria-hidden>·</span>
                <Link href={`/forum/${article.board.slug}`} className="text-stone-500 hover:text-amber-700 font-medium">
                  {article.board.name}
                </Link>
              </>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1 shrink-0">
            {isNew && (
              <span className="text-[0.625rem] px-1.5 py-0.5 bg-green-500 text-white rounded-full font-medium">新</span>
            )}
            {flairDef && (
              <span className={`inline-flex items-center px-1.5 py-0.5 text-[0.625rem] leading-none font-medium rounded-full ${flairDef.color}`}>
                {flairDef.label}
              </span>
            )}
            {article.isEssence && <span className="text-xs" title="精华">⭐</span>}
            {article.isPinned && <span className="text-xs" title="置顶">📌</span>}
            {article.status && article.status !== "published" && (
              <span className="text-[0.625rem] px-1.5 py-0.5 bg-stone-500 text-white rounded-full font-medium" title="审核通过后对所有人可见">
                ⏳ 审核中
              </span>
            )}
          </div>
        </div>

        {/* 行2：标题独占整行 */}
        <Link
          href={`/forum/thread/${article.id}`}
          className="block text-sm md:text-base font-semibold text-stone-800 hover:text-amber-800 leading-snug"
        >
          {article.title}
        </Link>
      </div>

      {/* 行3：正文预览（P2-R1 折叠 3 行可展开） */}
      {article.content && (
        <div className="px-3 pb-2.5 md:px-4 md:pb-3">
          <CollapsibleText text={article.content} />
        </div>
      )}

      {/* 行4：媒体 — 4:3 aspect ratio */}
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

      {/* 行5：底部操作行 — 投票（横排）/ 评论 / 关注 */}
      <div className="flex items-center gap-1 px-2.5 py-1.5 md:px-3 border-t border-stone-100 mt-auto">
        <VoteButton
          refId={article.id}
          type="article"
          initialUpvotes={article.upvotes}
          initialDownvotes={article.downvotes}
          initialValue={article.initialVote}
          size="sm"
        />
        <Link
          href={`/forum/thread/${article.id}`}
          className="flex items-center gap-1 px-2.5 h-8 rounded-lg text-xs text-stone-500 hover:bg-stone-100 hover:text-stone-700 transition"
          title="评论"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          {article.replyCount > 0 ? article.replyCount : "评论"}
        </Link>
        <div className="ml-auto">
          <FollowThreadButton articleId={article.id} />
        </div>
      </div>
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
          <span className="text-[0.625rem] text-white/70 ml-1 tabular-nums">{idx + 1}/{images.length}</span>
        </div>
      )}
    </Link>
  );
}
