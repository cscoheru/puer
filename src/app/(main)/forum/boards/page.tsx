import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { visibleArticleWhere } from "@/lib/article-visibility";
import Link from "next/link";

export const dynamic = "force-dynamic";

function timeAgo(dateStr: string | Date | null) {
  if (!dateStr) return "";
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

export default async function BoardsPage() {
  const session = await auth();

  const boards = await prisma.board.findMany({
    orderBy: { sortOrder: "asc" },
    include: { _count: { select: { articles: true } } },
  });

  const lastThreads = await Promise.all(
    boards.map((board) =>
      prisma.article.findFirst({
        where: { ...visibleArticleWhere(session?.user?.id), boardId: board.id },
        orderBy: { lastRepliedAt: "desc" },
        select: {
          id: true, title: true, lastRepliedAt: true, createdAt: true,
          author: { select: { id: true, username: true } },
        },
      })
    )
  );
  const lastThreadMap = new Map<string, (typeof lastThreads)[0]>();
  boards.forEach((board, i) => { if (lastThreads[i]) lastThreadMap.set(board.id, lastThreads[i]); });

  return (
    <div className="max-w-4xl mx-auto px-3 md:px-6 py-4 md:py-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-stone-800">版块列表</h1>
          <p className="text-stone-500 text-xs mt-0.5">浏览所有版块</p>
        </div>
        <Link href="/forum" className="text-sm text-amber-800 hover:text-amber-900">
          ← 返回信息流
        </Link>
      </div>

      {boards.length > 0 ? (
        <>
          <div className="hidden md:grid grid-cols-[1fr_70px_70px_220px] text-xs text-stone-400 px-4 py-2 bg-stone-50 border border-stone-200 rounded-t-lg">
            <span>版块</span>
            <span className="text-center">主题</span>
            <span className="text-center">帖子</span>
            <span>最后发表</span>
          </div>
          <div className="border border-t-0 border-stone-200 rounded-b-lg divide-y divide-stone-100 bg-white">
            {boards.map((board) => {
              const last = lastThreadMap.get(board.id);
              return (
                <div key={board.id}>
                  <div className="hidden md:grid grid-cols-[1fr_70px_70px_220px] px-4 py-3 hover:bg-stone-50 transition items-center">
                    <div>
                      <Link href={`/forum/${board.slug}`} className="text-sm font-semibold text-stone-700 hover:text-amber-800 transition">
                        {board.icon} {board.name}
                      </Link>
                      {board.description && <p className="text-xs text-stone-400 mt-0.5">{board.description}</p>}
                    </div>
                    <div className="text-center text-sm text-stone-600">{board.threadCount}</div>
                    <div className="text-center text-sm text-stone-600">{board.postCount}</div>
                    <div className="text-xs text-stone-400 min-w-0">
                      {last ? (
                        <>
                          <Link href={`/forum/thread/${last.id}`} className="text-amber-800 hover:text-amber-900 truncate block max-w-[200px]" title={last.title}>
                            {last.title}
                          </Link>
                          <span>by {last.author.username} · {timeAgo(last.lastRepliedAt || last.createdAt)}</span>
                        </>
                      ) : <span className="text-stone-300">暂无</span>}
                    </div>
                  </div>
                  <Link href={`/forum/${board.slug}`} className="md:hidden block px-4 py-3 hover:bg-stone-50 transition">
                    <div className="flex items-center gap-2">
                      <span className="text-base">{board.icon}</span>
                      <span className="text-sm font-semibold text-stone-700">{board.name}</span>
                    </div>
                    {board.description && <p className="text-xs text-stone-400 mt-0.5 ml-7">{board.description}</p>}
                    <div className="flex items-center gap-3 text-xs text-stone-400 mt-1.5 ml-7">
                      <span>{board.threadCount} 主题</span>
                      <span>{board.postCount} 帖子</span>
                      {last && <span className="ml-auto truncate">{last.title.slice(0, 20)}...</span>}
                    </div>
                  </Link>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="text-center py-16 border border-dashed border-stone-200 rounded-lg bg-white">
          <p className="text-stone-300 text-lg mb-1">📭</p>
          <p className="text-stone-400">暂无版块</p>
        </div>
      )}
    </div>
  );
}
