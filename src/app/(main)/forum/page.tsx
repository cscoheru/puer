import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import type { Metadata } from "next";
import ForumFeed from "@/components/forum-feed";
import ForumSidebar from "@/components/forum-sidebar";
import LatestPosts from "@/components/latest-posts";
import { fetchForumFeed } from "@/lib/forum-feed-server";

export const metadata: Metadata = {
  title: "普洱论坛 - 品茶交流社区",
  description: "普洱茶爱好者交流论坛。品茶心得分享、茶叶评测讨论、普洱茶知识问答。与万千茶友一起发现好茶。",
  keywords: ["普洱论坛", "品茶论坛", "茶友交流", "茶叶讨论", "普洱茶社区"],
  alternates: { canonical: "/forum" },
  openGraph: {
    title: "普洱论坛 - 品茶交流社区 | Puêr",
    description: "普洱茶爱好者交流论坛。品茶心得分享、茶叶评测讨论、普洱茶知识问答。",
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
