"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import ArticleCard from "@/components/tea/article-card";

export default function FavoritesPage() {
  const { data: session, status } = useSession();
  const [favorites, setFavorites] = useState<{ article: unknown }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status !== "authenticated" || !session?.user?.id) return;
    fetch(`/api/favorites?userId=${session.user.id}`)
      .then((res) => res.json())
      .then((data) => setFavorites(Array.isArray(data) ? data : []))
      .catch(() => setFavorites([]))
      .finally(() => setLoading(false));
  }, [status, session?.user?.id]);

  if (status === "loading") {
    return <div className="text-center py-12 text-stone-400">加载中...</div>;
  }

  if (status === "unauthenticated") {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 text-center">
        <p className="text-stone-500 mb-4">请先登录后查看收藏</p>
        <Link href="/login" className="inline-block bg-amber-800 text-white px-5 py-2.5 rounded-lg text-sm hover:bg-amber-900 transition">
          去登录
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-10">
      <h1 className="text-2xl md:text-4xl font-serif font-bold text-stone-800 mb-2">我的收藏</h1>
      <p className="text-stone-500 text-sm mb-6">
        {loading ? "加载中..." : `共 ${favorites.length} 篇收藏`}
      </p>

      {loading ? (
        <div className="text-center py-12 text-stone-400">加载中...</div>
      ) : favorites.length > 0 ? (
        <div className="space-y-3 md:space-y-4">
          {favorites.map((fav) => (
            <ArticleCard key={(fav.article as { id: string }).id} article={fav.article as Parameters<typeof ArticleCard>[0]["article"]} />
          ))}
        </div>
      ) : (
        <div className="text-center py-12">
          <p className="text-stone-400 mb-2">还没有收藏任何文章</p>
          <Link href="/" className="text-sm text-amber-700 hover:text-amber-800 transition">
            去看看文章
          </Link>
        </div>
      )}
    </div>
  );
}
