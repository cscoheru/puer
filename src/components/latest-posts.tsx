import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { visibleArticleWhere } from "@/lib/article-visibility";

function timeAgo(date: Date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return date.toLocaleDateString("zh-CN");
}

export default async function LatestPosts() {
  const session = await auth();
  let posts: any[] = [];
  try {
    posts = await prisma.article.findMany({
    // P2-R5：排除未升级的经典普洱跟进帖（与主 feed 一致，见 forum-feed-server.ts）
    where: {
      ...visibleArticleWhere(session?.user?.id),
      boardId: { not: null },
      AND: [
        {
          OR: [
            { teaId: null },
            { board: { slug: { not: "classics" } } },
            { promotedHomeAt: { not: null } },
          ],
        },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      title: true,
      createdAt: true,
      upvotes: true,
      downvotes: true,
      replyCount: true,
      content: true,
      videoUrl: true,
      board: { select: { slug: true, name: true } },
      author: { select: { id: true, username: true, avatar: true, level: true } },
    },
  });
  } catch {}

  // Extract first image from content for thumbnail;
  // for video posts without images in content, derive thumbnail from videoUrl
  const enriched = posts.map((p) => {
    const imgThumb = (p.content || "").match(/<img[^>]+src="([^">]+)"/)?.[1] || null;
    let videoThumb = null;
    if (!imgThumb && p.videoUrl) {
      const videoId = p.videoUrl.split("/").pop()?.replace(".mp4", "");
      if (videoId) videoThumb = `/uploads/videos/${videoId}.jpg`;
    }
    return { ...p, thumb: imgThumb || videoThumb };
  });

  return (
    <aside className="w-72 shrink-0 hidden xl:block">
      <div className="sticky top-20">
        <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-stone-50 border-b border-stone-200 sticky top-0">
            <h3 className="text-xs font-bold text-stone-600 uppercase tracking-wider">最新帖子</h3>
          </div>
          <div className="divide-y divide-stone-100 max-h-[calc(100vh-12rem)] overflow-y-auto" style={{ scrollbarWidth: "thin", scrollbarColor: "#d6d3d1 transparent" }}>
            {enriched.map((post) => (
              <Link
                key={post.id}
                href={`/forum/thread/${post.id}`}
                className="flex gap-2 px-3 py-2.5 hover:bg-stone-50 transition group"
              >
                {/* Thumbnail */}
                {post.thumb ? (
                  <div className="w-12 h-12 rounded-lg bg-stone-100 overflow-hidden shrink-0 mt-0.5">
                    <img src={post.thumb} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                  </div>
                ) : post.videoUrl ? (
                  <div className="w-12 h-12 rounded-lg bg-black overflow-hidden shrink-0 mt-0.5 relative flex items-center justify-center">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="white" className="opacity-70"><path d="M8 5v14l11-7z" /></svg>
                  </div>
                ) : null}

                {/* Text */}
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-stone-700 group-hover:text-amber-800 leading-snug line-clamp-2 font-medium">
                    {post.title}
                  </p>
                  <div className="flex items-center gap-1 mt-1 text-[0.625rem] text-stone-400">
                    <span>{post.author.username}</span>
                    <span>·</span>
                    <span suppressHydrationWarning>{timeAgo(post.createdAt)}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-[0.625rem] text-stone-400">
                    <span>👍 {post.upvotes}</span>
                    <span>💬 {post.replyCount}</span>
                    {post.board && (
                      <>
                        <span>·</span>
                        <span className="text-stone-400">{post.board.name}</span>
                      </>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}
