"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";

interface AuthorInfo {
  id: string;
  username: string;
  avatar: string | null;
  level: number;
  bio: string | null;
  teaAge: number | null;
  createdAt: string;
  postCount?: number;
  karma: number;
  followerCount: number;
  registrationRegion?: string | null;
}

function FollowButton({ userId }: { userId: string }) {
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((s) => {
        if (!s?.user?.id || s.user.id === userId) return;
        setSessionUserId(s.user.id);
        return fetch(`/api/follow/user?userId=${userId}`)
          .then((r) => r.json())
          .then((data) => setFollowing(data.following))
          .catch(() => {});
      })
      .catch(() => {});
  }, [userId]);

  if (!sessionUserId) return null;

  const toggle = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/follow/user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
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
      className="text-xs px-3 py-1 rounded-full border transition"
      style={{ borderColor: following ? "#92400e" : "#d6d3d1", color: following ? "#fff" : "#57534e", backgroundColor: following ? "#92400e" : "transparent" }}
    >
      {loading ? "..." : following ? "已关注" : "关注"}
    </button>
  );
}

export default function AuthorHover({ author }: { author: AuthorInfo }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<"left" | "right">("right");
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onScroll() { setOpen(false); }
    document.addEventListener("click", onClick);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // Position check after open
  useEffect(() => {
    if (!open || !cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    setPos(rect.right + 280 > window.innerWidth ? "left" : "right");
  }, [open]);

  return (
    <div className="relative inline-block">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className="font-medium text-stone-500 hover:text-amber-700 transition"
      >
        {author.username}
      </button>

      {open && (
        <div
          ref={cardRef}
          className={`absolute top-full mt-1 z-50 w-64 bg-white border border-stone-200 rounded-lg shadow-lg p-3 ${pos === "right" ? "left-0" : "right-0"}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 mb-2">
            {author.avatar ? (
              <img src={author.avatar} alt="" className="w-10 h-10 rounded-full object-cover" />
            ) : (
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 font-bold text-sm">
                {author.username[0]}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-stone-800 text-sm truncate">{author.username}</div>
              <div className="text-xs text-stone-400">Lv.{author.level}</div>
            </div>
            <FollowButton userId={author.id} />
          </div>

          <div className="space-y-1 text-xs text-stone-500">
            {author.postCount !== undefined && (
              <div className="flex justify-between">
                <span>帖子</span>
                <span className="font-medium text-stone-700">{author.postCount}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span>粉丝</span>
              <span className="font-medium text-stone-700">{author.followerCount}</span>
            </div>
            <div className="flex justify-between">
              <span>声望</span>
              <span className="font-medium text-stone-700">{author.karma}</span>
            </div>
            {author.teaAge && (
              <div className="flex justify-between">
                <span>茶龄</span>
                <span className="font-medium text-stone-700">{author.teaAge}年</span>
              </div>
            )}
            <div className="flex justify-between">
              <span>加入</span>
              <span className="font-medium text-stone-700">
                {author.createdAt ? new Date(author.createdAt).getFullYear() + "年" : ""}
              </span>
            </div>
            {author.bio && (
              <div className="border-t border-stone-100 pt-1.5 mt-1.5 text-stone-400 italic leading-relaxed text-left">
                {author.bio}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
