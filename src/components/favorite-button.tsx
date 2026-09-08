"use client";

import { useState, useTransition } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";

interface FavoriteButtonProps {
  articleId: string;
  initialFavorited?: boolean;
}

export default function FavoriteButton({ articleId, initialFavorited = false }: FavoriteButtonProps) {
  const { data: session } = useSession();
  const [favorited, setFavorited] = useState(initialFavorited);
  const [pending, startTransition] = useTransition();

  function toggle() {
    if (!session?.user) return;

    startTransition(async () => {
      setFavorited(!favorited);
      try {
        const res = await fetch("/api/favorites", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ articleId }),
        });
        if (!res.ok) throw new Error();
        const data = await res.json();
        setFavorited(data.favorited);
      } catch {
        setFavorited(favorited);
      }
    });
  }

  if (!session?.user) {
    return (
      <Link
        href="/login"
        className="inline-flex items-center gap-1.5 text-sm text-stone-400 hover:text-amber-600 transition"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="size-4">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
        <span>收藏</span>
      </Link>
    );
  }

  return (
    <button
      onClick={toggle}
      disabled={pending}
      className={`inline-flex items-center gap-1.5 text-sm transition ${
        favorited
          ? "text-amber-600"
          : "text-stone-400 hover:text-amber-600"
      } ${pending ? "opacity-50" : ""}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill={favorited ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={2}
        className="size-4"
      >
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
      <span>{favorited ? "已收藏" : "收藏"}</span>
    </button>
  );
}
