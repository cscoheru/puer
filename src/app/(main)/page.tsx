import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { visibleArticleWhere } from "@/lib/article-visibility";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Puêr — 以茶会友，品鉴真味",
  description: "Puêr（puer.im）普洱茶爱好者社区 — 品茶交流论坛、茶品百科、云喝茶、互换大厅。普洱醇香，以茶会友。",
  keywords: ["普洱茶", "puer", "puer.im", "普洱论坛", "品茶", "云喝茶", "互换大厅", "普洱醇香", "茶友社区", "茶叶评测"],
  alternates: { canonical: "/" },
};

export const dynamic = "force-dynamic";
export const revalidate = 300;

export default async function HomePage() {
  const session = await auth();
  const [articleCount, teaCount, userCount] = await Promise.all([
    prisma.article.count({ where: { ...visibleArticleWhere(session?.user?.id) } }).catch(() => 0),
    prisma.tea.count().catch(() => 0),
    prisma.user.count().catch(() => 0),
  ]);

  const recentArticles = await prisma.article.findMany({
    // P2-R5：排除未升级的经典普洱跟进帖（与主 feed 一致，见 forum-feed-server.ts）
    where: {
      ...visibleArticleWhere(session?.user?.id),
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
    select: {
      id: true, title: true, createdAt: true,
      author: { select: { username: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 6,
  }).catch(() => []);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 md:py-16">
      {/* Hero */}
      <section className="text-center mb-12">
        <h1 className="text-3xl md:text-5xl font-serif font-bold text-stone-800 mb-4">
          Puêr — 以茶会友，品鉴真味
        </h1>
        <p className="text-stone-500 text-lg md:text-xl max-w-2xl mx-auto">
          普洱茶爱好者社区。品茶交流、茶品百科、云喝茶、互换大厅。
        </p>
        <div className="flex gap-4 justify-center mt-6">
          <Link href="/forum" className="px-6 py-2.5 bg-amber-800 text-white rounded-lg hover:bg-amber-900 transition font-medium">
            进入论坛
          </Link>
          <Link href="/tea" className="px-6 py-2.5 border border-amber-800 text-amber-800 rounded-lg hover:bg-amber-50 transition font-medium">
            茶品百科
          </Link>
        </div>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-3 gap-4 mb-12 text-center">
        {[
          { value: articleCount, label: "篇帖子" },
          { value: teaCount, label: "款茶品" },
          { value: userCount, label: "位茶友" },
        ].map((s) => (
          <div key={s.label} className="bg-white border border-stone-200 rounded-lg p-4">
            <div className="text-2xl md:text-3xl font-bold text-amber-800">{s.value}</div>
            <div className="text-sm text-stone-500">{s.label}</div>
          </div>
        ))}
      </section>

      {/* Features */}
      <section className="grid md:grid-cols-2 gap-4 mb-12">
        {[
          { href: "/forum", title: "普洱论坛", desc: "品茶心得分享、茶叶评测讨论、普洱茶知识问答", icon: "💬" },
          { href: "/tea", title: "茶品百科", desc: "各大品牌、各年份普洱茶品评测、口感评分、茶友点评", icon: "📖" },
          { href: "/exchange", title: "互换大厅", desc: "茶友间茶版买卖、交换、转让信息发布", icon: "🔄" },
          { href: "/sessions", title: "云喝茶", desc: "在线品茶互动，与茶友实时交流品鉴心得", icon: "☁️" },
        ].map((f) => (
          <Link key={f.href} href={f.href} className="bg-white border border-stone-200 rounded-lg p-5 hover:shadow-md hover:border-amber-200 transition group">
            <div className="text-2xl mb-2">{f.icon}</div>
            <h2 className="font-bold text-stone-800 group-hover:text-amber-800 transition">{f.title}</h2>
            <p className="text-sm text-stone-500 mt-1">{f.desc}</p>
          </Link>
        ))}
      </section>

      {/* Recent posts */}
      {recentArticles.length > 0 && (
        <section>
          <h2 className="text-xl font-bold text-stone-800 mb-4">最新帖子</h2>
          <div className="space-y-2">
            {recentArticles.map((a) => (
              <Link key={a.id} href={`/forum/thread/${a.id}`} className="block bg-white border border-stone-200 rounded-lg p-3 hover:shadow-sm transition">
                <span className="text-stone-800 font-medium">{a.title}</span>
                <span className="text-xs text-stone-400 ml-2">{a.author.username}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
