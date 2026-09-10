import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

const NAV_ITEMS = [
  { href: "/forum", label: "首页", icon: "🏠" },
  { href: "/forum/explore", label: "探索社区", icon: "🔍" },
  { href: "/forum/communities/new", label: "新建社区", icon: "➕" },
];

export default async function ForumSidebar() {
  let session: { user?: { id?: string } } | null = null;
  try { session = await auth(); } catch {}
  let boards: Array<{ id: string; name: string; slug: string; icon: string | null; threadCount: number }> = [];
  try {
    boards = await prisma.board.findMany({
    orderBy: { sortOrder: "asc" },
    select: { id: true, name: true, slug: true, icon: true, threadCount: true },
  });
  } catch {}

  return (
    <aside className="w-56 lg:w-64 shrink-0 hidden lg:block">
      <div className="sticky top-20 space-y-3">
        {/* 导航 */}
        <nav className="bg-white border border-stone-200 rounded-lg p-2">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-stone-600 hover:bg-stone-100 hover:text-stone-800 transition"
            >
              <span className="text-base">{item.icon}</span>
              <span className="font-medium">{item.label}</span>
            </Link>
          ))}
          {session?.user && (
            <Link
              href="/forum/new"
              className="flex items-center gap-2.5 px-3 py-2 mt-1 rounded-lg text-sm font-medium bg-amber-800 text-white hover:bg-amber-900 transition"
            >
              <span className="text-base">✏️</span>
              <span>发布新帖</span>
            </Link>
          )}
        </nav>

        {/* 经典普洱 — 经典品种档案与转化跟进（位于"发布新帖"与"社区"之间） */}
        <Link
          href="/forum/classics"
          className="block bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-lg p-3 hover:border-amber-400 hover:shadow-sm transition group"
        >
          <div className="flex items-center gap-2.5">
            <span className="text-xl shrink-0">🏵️</span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-amber-900 group-hover:text-amber-800 transition">
                经典普洱
              </div>
              <div className="text-[0.6875rem] text-stone-500 truncate">经典品种档案 · 转化跟进</div>
            </div>
            <span className="ml-auto text-stone-300 group-hover:text-amber-600 transition text-lg">›</span>
          </div>
        </Link>

        {/* 社区 — 版块列表 */}
        <div className="bg-white border border-stone-200 rounded-lg p-3">
          <h3 className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-2 px-1">
            社区
          </h3>
          <div className="space-y-0.5">
            {boards.map((board) => (
              <Link
                key={board.id}
                href={`/forum/${board.slug}`}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-stone-600 hover:bg-stone-100 hover:text-stone-800 transition"
              >
                <span className="text-base shrink-0">{board.icon || "📄"}</span>
                <span className="truncate">{board.name}</span>
                {board.threadCount > 0 && (
                  <span className="ml-auto text-[0.625rem] text-stone-400">{board.threadCount}</span>
                )}
              </Link>
            ))}
          </div>
        </div>

        {/* 资源 */}
        <div className="bg-white border border-stone-200 rounded-lg p-3">
          <div className="space-y-0.5">
            <Link href="/about" className="block px-2 py-1.5 rounded-lg text-sm text-stone-600 hover:bg-stone-100 hover:text-stone-800 transition">
              关于 PuEr
            </Link>
            <Link href="/advertise" className="block px-2 py-1.5 rounded-lg text-sm text-stone-600 hover:bg-stone-100 hover:text-stone-800 transition">
              广告合作
            </Link>
            <Link href="/help" className="block px-2 py-1.5 rounded-lg text-sm text-stone-600 hover:bg-stone-100 hover:text-stone-800 transition">
              帮助
            </Link>
          </div>
        </div>

        {/* 规则与条款 */}
        <div className="px-3 space-y-1">
          <Link href="/rules" className="block text-xs text-stone-400 hover:text-stone-600 transition">
            社区规则
          </Link>
          <Link href="/privacy" className="block text-xs text-stone-400 hover:text-stone-600 transition">
            隐私政策
          </Link>
          <Link href="/terms" className="block text-xs text-stone-400 hover:text-stone-600 transition">
            用户协议
          </Link>
        </div>
      </div>
    </aside>
  );
}
