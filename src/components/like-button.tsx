"use client";

import { useState, useTransition } from "react";

interface LikeButtonProps {
  articleId: string;
  initialLiked: boolean;
  initialCount: number;
}

export default function LikeButton({ articleId, initialLiked, initialCount }: LikeButtonProps) {
  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [pending, startTransition] = useTransition();

  function toggle() {
    startTransition(async () => {
      // Optimistic update
      setLiked(!liked);
      setCount((c) => (liked ? c - 1 : c + 1));

      try {
        const res = await fetch("/api/likes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "article", refId: articleId, articleId }),
        });
        if (!res.ok) throw new Error("Failed");
        const data = await res.json();
        // Sync with server state
        setLiked(data.liked);
        setCount((c) => c);
      } catch {
        // Revert on error
        setLiked(liked);
        setCount(initialCount);
      }
    });
  }

  return (
    <button
      onClick={toggle}
      disabled={pending}
      className={`inline-flex items-center gap-1.5 text-sm transition ${
        liked
          ? "text-red-500"
          : "text-stone-400 hover:text-red-400"
      } ${pending ? "opacity-50" : ""}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill={liked ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={2}
        className="size-4"
      >
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
      </svg>
      <span>{count}</span>
    </button>
  );
}
