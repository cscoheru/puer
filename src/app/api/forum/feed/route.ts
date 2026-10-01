import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { fetchForumFeed, toTraditionalFeed } from "@/lib/forum-feed-server";

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
  const offset = Math.max(0, parseInt(searchParams.get("offset") || "0", 10) || 0);
  const limit = Math.min(30, Math.max(1, parseInt(searchParams.get("limit") || "10", 10) || 10));
  const locale = searchParams.get("locale");

  const session = await auth();
  try {
    const { articles, hasMore } = await fetchForumFeed({
      tab,
      userId: session?.user?.id,
      offset,
      limit,
    });
    return NextResponse.json({
      articles: locale === "zh-TW" ? toTraditionalFeed(articles) : articles,
      hasMore,
      offset,
      limit,
    });
  } catch (e) {
    console.error("[api/forum/feed]", e);
    return NextResponse.json({ error: "加载失败" }, { status: 500 });
  }
}
