import { prisma } from "@/lib/prisma";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ExplorePage() {
  const boards = await prisma.board.findMany({
    orderBy: { threadCount: "desc" },
    include: { _count: { select: { articles: true } } },
  });

  const totalUsers = await prisma.user.count();
  const totalPosts = await prisma.article.count({ where: { status: "published" } });

  return (
    <div>
      <h1 className="text-lg font-bold text-stone-800 mb-1">探索社区</h1>
      <p className="text-xs text-stone-400 mb-4">
        {boards.length} 个社区 · {totalUsers} 位茶友 · {totalPosts} 篇帖子
      </p>

      <div className="grid gap-2">
        {boards.map((board) => (
          <Link
            key={board.id}
            href={`/forum/${board.slug}`}
            className="flex items-center gap-3 bg-white border border-stone-200 rounded-lg px-4 py-3 hover:border-amber-300 hover:shadow-sm transition"
          >
            <div className="w-10 h-10 rounded-lg bg-stone-100 flex items-center justify-center text-lg shrink-0">
              {board.icon || "📋"}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-stone-700">{board.name}</h2>
              {board.description && (
                <p className="text-xs text-stone-400 line-clamp-1">{board.description}</p>
              )}
              <p className="text-xs text-stone-400 mt-0.5">
                {board.threadCount} 主题 · {board._count.articles} 帖子
              </p>
            </div>
            <span className="text-xs text-amber-700 font-medium shrink-0">浏览 →</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
