import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import type { Metadata } from "next";
import ForumFeed from "@/components/forum-feed";
import ForumSidebar from "@/components/forum-sidebar";
import LatestPosts from "@/components/latest-posts";
import { fetchForumFeed } from "@/lib/forum-feed-server";

export const metadata: Metadata = {
  title: "普洱茶论坛_普洱茶交流社区_生普熟普品鉴 - PuerHub",
  description:
    "PuerHub 普洱茶论坛：生普/熟普品鉴交流、大益等经典中老期茶档案、仓储行情讨论与茶友问答。普洱茶爱好者聚集地，以茶会友。",
  keywords: [
    "普洱茶论坛", "普洱论坛", "普洱茶", "普洱茶社区", "生普", "熟普", "大益", "经典普洱",
    "中老期茶", "品鉴", "茶友交流", "puer tea forum", "puerim",
  ],
  alternates: { canonical: "/forum" },
  openGraph: {
    title: "普洱茶论坛 - 生普熟普品鉴 | PuerHub 普洱茶社区",
    description: "生普/熟普品鉴交流、大益等经典中老期茶档案、仓储行情讨论与茶友问答。",
  },
};

export const dynamic = "force-dynamic";

export default async function ForumPage(props: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const searchParams = await props.searchParams;
  // v4 hot ranking: windowed tabs (day/week/month) + latest/essence.
  // Legacy ?tab=hot maps to week (the new default).
  const VALID_TABS = ["day", "week", "month", "latest", "essence"] as const;
  let tab = searchParams.tab || "week";
  if (tab === "hot") tab = "week";
  if (!(VALID_TABS as readonly string[]).includes(tab)) tab = "week";
  const session = await auth();

  const boards = await prisma.board.findMany({
    orderBy: { sortOrder: "asc" },
  });

  // 首屏数据：与移动端懒加载（/api/forum/feed）共用 fetchForumFeed，
  // 保证 SSR 首屏与后续分页排序一致（v4 热榜窗口算法见 lib 内注释）。
  // P2-R5：经典普洱跟进帖已在数据层排除（升级后进入），页面不再单独查询。
  const { articles: feedArticles } = await fetchForumFeed({
    tab,
    userId: session?.user?.id,
  });

  return (
    <div className="flex gap-4 md:gap-6 px-2 md:px-4 max-w-screen-2xl mx-auto">
      <ForumSidebar />
      <div className="flex-1 min-w-0">
        <ForumFeed
          articles={feedArticles}
          boards={boards.map((b) => ({ id: b.id, name: b.name, slug: b.slug, icon: b.icon }))}
          currentUserId={session?.user?.id}
          tab={tab}
        />
      </div>
      <LatestPosts />
    </div>
  );
}
