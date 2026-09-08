"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";

interface Props {
  userId: string;
}

export default function JoinButton({ userId }: Props) {
  const { data: session } = useSession();
  const [following, setFollowing] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!session?.user || session.user.id === userId) return;
    fetch(`/api/follow/user?userId=${userId}`)
      .then((r) => r.json())
      .then((data) => setFollowing(data.following))
      .catch(() => {});
  }, [userId, session]);

  if (!session?.user || session.user.id === userId) return null;

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
      className={`text-xs px-2.5 py-1 rounded-lg border transition min-h-[32px] ${
        following
          ? "bg-amber-800 text-white border-amber-800"
          : "border-amber-300 text-amber-700 hover:bg-amber-50"
      }`}
    >
      {loading ? "..." : following ? "已关注" : "+ 关注"}
    </button>
  );
}
