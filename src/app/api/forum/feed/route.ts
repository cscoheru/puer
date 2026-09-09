import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { fetchForumFeed } from "@/lib/forum-feed-server";

/**
 * 移动端推荐流懒加载（P2-R3）。
 * GET /api/forum/feed?tab=week&offset=10&limit=10
 * - 与首屏 SSR 共用 fetchForumFeed（同一套 v4 热榜算法）
 * - offset 为服务端游标（含被客户端去重丢弃的条目），客户端原样透传
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const tab = searchParams.get("tab") || "week";
  const offset = Math.max(0, parseInt(searchParams.get("offset") || "0", 10) || 0);
  const limit = Math.min(30, Math.max(1, parseInt(searchParams.get("limit") || "10", 10) || 10));

  const session = await auth();
  try {
    const { articles, hasMore } = await fetchForumFeed({
      tab,
      userId: session?.user?.id,
      offset,
      limit,
    });
    return NextResponse.json({ articles, hasMore, offset, limit });
  } catch (e) {
    console.error("[api/forum/feed]", e);
    return NextResponse.json({ error: "加载失败" }, { status: 500 });
  }
}
