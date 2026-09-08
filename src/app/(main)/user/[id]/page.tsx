import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { getLevelConfigs, getLevelName } from "@/lib/level-config";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import ArticleCard from "@/components/tea/article-card";
import JoinButton from "@/components/join-button";
import MessageButton from "@/components/message-button";
import TeaInventorySection from "@/components/tea-exchange/tea-inventory-section";
import TeaWishSection from "@/components/tea-exchange/tea-wish-section";
import TradeRequestList from "@/components/tea-exchange/trade-request-list";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const user = await prisma.user.findUnique({
    where: { id },
    select: { username: true, level: true },
  });
  if (!user) return { title: "用户未找到" };
  const levelName = getLevelName(user.level);
  return {
    title: `${user.username}的个人主页`,
    description: `${user.username}（${levelName}）— 查看该茶友的帖子、茶版、心愿单和交易记录`,
    alternates: { canonical: `/user/${id}` },
    openGraph: {
      title: `${user.username}的个人主页 | Puêr`,
      description: `${user.username}（${levelName}）的普洱茶友主页`,
    },
  };
}

export default async function UserProfilePage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { tab } = await searchParams;

  const session = await auth();
  const isOwner = session?.user?.id === id;

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      uid: true,
      username: true,
      nickname: true,
      avatar: true,
      bio: true,
      level: true,
      exp: true,
      karma: true,
      followerCount: true,
      teaAge: true,
      preferenceTags: true,
      createdAt: true,
      articles: {
        where: { status: "published", ...(isOwner ? {} : { visibility: { not: "private" } }) },
        include: {
          author: { select: { username: true, avatar: true, level: true } },
          tea: { select: { name: true, brand: true, year: true } },
          _count: { select: { comments: true, likes: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      },
    },
  }).catch(() => null);

  if (!user) notFound();

  // Moderator info
  const modBoards = await prisma.boardModerator.findMany({
    where: { userId: user.id, status: "approved" },
    include: { board: { select: { name: true, slug: true } } },
  });

  const levelConfigs = await getLevelConfigs();
  const userLevelName = await getLevelName(user.level);
  const nextLevelName = await getLevelName(user.level + 1);

  const totalLikes = user.articles.reduce((sum, a) => sum + a._count.likes, 0);
  const totalViews = user.articles.reduce((sum, a) => sum + a.viewCount, 0);

  const followedPostCount = await prisma.article.count({
    where: { authorId: user.id, followedBy: { some: {} } },
  });

  const nextReq = levelConfigs.find((c) => c.level === user.level + 1);
  const currentReq = levelConfigs.find((c) => c.level === user.level);
  const expProgress = nextReq && currentReq ? Math.min((user.exp - currentReq.expRequired) / (nextReq.expRequired - currentReq.expRequired) * 100, 100) : 100;

  const dateStr = new Date(user.createdAt).toLocaleDateString("zh-CN", {
    year: "numeric", month: "long", day: "numeric",
  });

  const activeTab = tab || "posts";

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-10">
      {/* Profile header */}
      <div className="bg-white rounded-xl border border-stone-200 p-5 md:p-8">
        <div className="flex items-start gap-4 md:gap-6">
          <div className="w-16 h-16 md:w-20 md:h-20 rounded-full bg-amber-100 flex items-center justify-center text-2xl md:text-3xl font-bold text-amber-800 shrink-0">
            {user.avatar ? (
              <img src={user.avatar} alt="" className="w-full h-full rounded-full object-cover" />
            ) : (
              user.username[0]
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl md:text-2xl font-bold text-stone-800">{user.username}</h1>
              {user.uid && <span className="text-xs font-mono text-stone-400">#{user.uid}</span>}
              <span className="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">
                Lv.{user.level} {userLevelName}
              </span>
              {modBoards.map((m) => (
                <span key={m.id} className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full flex items-center gap-1">
                  🛡️ {m.board.name}
                </span>
              ))}
              <JoinButton userId={user.id} />
              <MessageButton targetId={user.id} targetName={user.nickname || user.username} />
            </div>

            {user.bio && (
              <p className="text-sm text-stone-500 mt-1.5">{user.bio}</p>
            )}

            <div className="flex flex-wrap gap-3 mt-3 text-xs text-stone-400">
              <span>加入于 {dateStr}</span>
              {user.teaAge && <span>茶龄 {user.teaAge} 年</span>}
            </div>

            {user.preferenceTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {user.preferenceTags.map((tag) => (
                  <span key={tag} className="px-2 py-0.5 bg-stone-50 text-stone-500 rounded text-xs">
                    #{tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Exp bar */}
        <div className="mt-4 pt-4 border-t border-stone-100">
          <div className="flex items-center justify-between text-xs text-stone-500 mb-1">
            <span>Lv.{user.level} {userLevelName} — 经验值 {user.exp}</span>
            {nextReq && (
              <span>下一级 {nextLevelName}: {nextReq.expRequired} 经验</span>
            )}
          </div>
          <div className="w-full h-2 bg-stone-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-amber-400 to-amber-600 rounded-full transition-all"
              style={{ width: `${expProgress}%` }}
            />
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-3 mt-4">
          {[
            { label: "帖子", value: user.articles.length },
            { label: "粉丝", value: user.followerCount },
            { label: "声望", value: user.karma },
            { label: "获赞", value: totalLikes },
            { label: "阅读", value: totalViews },
            { label: "被关注帖子", value: followedPostCount },
          ].map(({ label, value }) => (
            <div key={label} className="text-center p-3 bg-stone-50 rounded-lg">
              <div className="text-lg md:text-xl font-bold text-amber-800">{value}</div>
              <div className="text-xs text-stone-400">{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 mt-6 border-b border-stone-200">
        {[
          { key: "posts", label: "发布内容" },
          { key: "inventory", label: "我的茶版" },
          { key: "wish", label: "我想要" },
          ...(isOwner ? [{ key: "requests" as const, label: "交易请求" }] : []),
        ].map(({ key, label }) => (
          <Link
            key={key}
            href={`/user/${id}?tab=${key}`}
            className={`px-4 py-2.5 text-sm transition ${
              activeTab === key
                ? "text-amber-700 border-b-2 border-amber-600 font-medium"
                : "text-stone-500 hover:text-stone-700"
            }`}
          >
            {label}
          </Link>
        ))}
      </div>

      {/* Tab content */}
      <div className="mt-4">
        {activeTab === "posts" && (
          <>
            {user.articles.length === 0 ? (
              <p className="text-center py-8 text-sm text-stone-400 bg-white rounded-xl border border-dashed border-stone-200">
                暂无已发布的文章
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
                {user.articles.map((article) => (
                  <ArticleCard key={article.id} article={article} />
                ))}
              </div>
            )}
          </>
        )}
        {activeTab === "inventory" && (
          <TeaInventorySection userId={id} isOwner={isOwner} />
        )}
        {activeTab === "wish" && (
          <TeaWishSection userId={id} isOwner={isOwner} />
        )}
        {activeTab === "requests" && isOwner && (
          <TradeRequestList userId={id} />
        )}
      </div>
    </div>
  );
}
