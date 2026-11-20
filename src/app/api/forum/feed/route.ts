import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { auth } from "@/lib/auth";
import { feedLogCategory } from "@/lib/comment-feed-errors";
import { isFeedInlineRepliesEnabled } from "@/lib/feed-comment-contract";
import { fetchForumFeed, toTraditionalFeed } from "@/lib/forum-feed-server";
import { clampOffset, paginationCapped } from "@/lib/pagination-limits";
import { can } from "@/lib/permissions";

/**
 * 移动端推荐流懒加载（P2-R3）。
 * GET /api/forum/feed?tab=week&offset=10&limit=10&locale=zh-TW
 * - 与首屏 SSR 共用 fetchForumFeed（同一套 v4 热榜算法）
 * - offset 为服务端游标（含被客户端去重丢弃的条目），客户端原样透传
 * - locale=zh-TW 时标题/正文/版块名转繁后再返回。这一步必须在服务端做：
 *   ForumFeed 是客户端组件，convertText 带 server-only 守卫进不去，
 *   简体字段一旦越过边界就会静默渲染成"繁体外壳 + 简体正文"
 *   （首屏 SSR 走 toTraditionalFeed，两条路径共用同一转换，见该函数注释）。
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const tab = searchParams.get("tab") || "week";
  const requestedOffset = Math.max(0, parseInt(searchParams.get("offset") || "0", 10) || 0);
  const limit = Math.min(30, Math.max(1, parseInt(searchParams.get("limit") || "10", 10) || 10));
  const locale = searchParams.get("locale");

  const session = await auth();
  const isAdmin = can(session?.user, "admin:access");
  // F0 反滥用：信息流滚到底有上限（管理员不受限）。offset 是服务端游标，
  // 越界时收敛到上限并告知客户端「已到底」，避免客户端无限下滑。
  const offset = clampOffset(requestedOffset, { isAdmin });
  const inlineReplies = isFeedInlineRepliesEnabled(process.env.FEED_INLINE_REPLIES);
  const loadId = inlineReplies ? randomUUID() : undefined;
  // Built before the read so the failure response carries the same correlation
  // headers as the success path (a 500 without a load ID cannot be traced back
  // to the feed request that produced it).
  const feedHeaders = (id: string | undefined) => {
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Vary": "Cookie",
    });
    if (id) headers.set("X-Comment-Load-ID", id);
    return headers;
  };
  try {
    const { articles, hasMore, commentLoadId } = await fetchForumFeed({
      tab,
      viewer: session?.user,
      offset,
      limit,
      inlineReplies,
      commentLoadId: loadId,
    });
    return NextResponse.json({
      articles: locale === "zh-TW" ? toTraditionalFeed(articles) : articles,
      hasMore,
      offset,
      limit,
      capped: paginationCapped(requestedOffset, offset),
    }, { headers: feedHeaders(commentLoadId ?? loadId) });
  } catch (e) {
    console.error("[api/forum/feed]", JSON.stringify({
      commentLoadId: loadId,
      category: feedLogCategory(e),
    }));
    return NextResponse.json({ error: "加载失败" }, { status: 500, headers: feedHeaders(loadId) });
  }
}
