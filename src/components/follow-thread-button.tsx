"use client";

import { useState, useEffect } from "react";

interface Props {
  articleId: string;
}

export default function FollowThreadButton({ articleId }: Props) {
  const [session, setSession] = useState<{ user?: { id?: string } } | null>(null);
  const [following, setFollowing] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((s) => {
        setSession(s);
        if (s?.user) {
          return fetch(`/api/follow/article?articleId=${articleId}`)
            .then((r) => r.json())
            .then((data) => setFollowing(data.following))
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [articleId]);

  if (!session?.user) return null;

  const toggle = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/follow/article", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ articleId }),
      });
      const data = await res.json();
      setFollowing(data.following);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={toggle}
      disabled={loading}
      className={`text-xs px-2.5 py-1.5 rounded-lg border transition min-h-[36px] ${
        following
          ? "bg-amber-800 text-white border-amber-800"
          : "border-stone-300 text-stone-600 hover:border-amber-300 hover:text-amber-700"
      }`}
    >
      {loading ? "..." : following ? "已关注" : "关注帖子"}
    </button>
  );
}
