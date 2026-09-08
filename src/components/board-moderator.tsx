"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";

interface Moderator {
  id: string;
  role: string;
  user: { id: string; username: string; nickname?: string | null; avatar: string | null; level: number };
}

export default function BoardModerator({ boardSlug }: { boardSlug: string }) {
  const { data: session } = useSession();
  const [mods, setMods] = useState<Moderator[]>([]);
  const [showApply, setShowApply] = useState(false);
  const [teaAge, setTeaAge] = useState("");
  const [reason, setReason] = useState("");
  const [applying, setApplying] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [myStatus, setMyStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/boards/${boardSlug}/moderators`)
      .then((r) => r.json())
      .then(setMods)
      .catch(() => {});
  }, [boardSlug]);

  // Check user's own moderator status
  useEffect(() => {
    if (!session?.user) return;
    fetch(`/api/admin/moderators`)
      .then((r) => r.json())
      .then((list) => {
        const mine = list.find(
          (m: { userId: string; board: { slug: string }; status: string }) =>
            m.userId === session.user.id && m.board.slug === boardSlug
        );
        if (mine) setMyStatus(mine.status);
      })
      .catch(() => {});
  }, [session, boardSlug]);

  const handleApply = async (e: React.FormEvent) => {
    e.preventDefault();
    setApplying(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/boards/${boardSlug}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teaAge, reason }),
      });
      const data = await res.json();
      if (res.ok) {
        setMsg({ ok: true, text: "申请已提交，等待管理员审核" });
        setShowApply(false);
        setMyStatus("pending");
      } else {
        setMsg({ ok: false, text: data.error || "提交失败" });
      }
    } catch {
      setMsg({ ok: false, text: "网络错误" });
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="mt-3 mb-2">
      {/* Moderator list */}
      {mods.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-stone-500 mb-2">
          <span>版主：</span>
          {mods.map((m) => (
            <Link
              key={m.id}
              href={`/user/${m.user.id}?tab=inventory`}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-stone-100 hover:bg-amber-50 text-stone-600 hover:text-amber-800 transition"
            >
              {m.user.avatar ? (
                <img src={m.user.avatar} alt="" className="w-4 h-4 rounded-full object-cover" />
              ) : (
                <span className="w-4 h-4 rounded-full bg-amber-100 flex items-center justify-center text-[8px]">
                  {(m.user.nickname || m.user.username)[0]}
                </span>
              )}
              <span>{m.user.nickname || m.user.username}</span>
              <span className="text-[10px]">{m.role === "deputy" ? "🛡️副" : "🛡️"}</span>
            </Link>
          ))}
        </div>
      )}

      {/* Apply button */}
      {session?.user && !myStatus && (
        <button
          onClick={() => setShowApply(!showApply)}
          className="text-xs text-amber-600 hover:text-amber-800 transition"
        >
          {showApply ? "取消申请" : "📋 申请版主"}
        </button>
      )}

      {myStatus === "pending" && (
        <span className="text-xs text-amber-600">⏳ 版主申请审核中</span>
      )}
      {myStatus === "rejected" && (
        <span className="text-xs text-red-500">❌ 申请未通过，可重新申请</span>
      )}

      {/* Apply form */}
      {showApply && (
        <form onSubmit={handleApply} className="mt-2 p-3 bg-stone-50 border border-stone-200 rounded-lg space-y-2 max-w-md">
          <div>
            <label className="block text-xs text-stone-500 mb-0.5">普洱茶龄（年）</label>
            <input
              type="number"
              value={teaAge}
              onChange={(e) => setTeaAge(e.target.value)}
              required
              min={1}
              max={80}
              className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm"
              placeholder="如：5"
            />
          </div>
          <div>
            <label className="block text-xs text-stone-500 mb-0.5">申请理由</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              rows={3}
              className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm resize-none"
              placeholder="说说你对这个版块的理解和你打算如何管理..."
            />
          </div>
          {msg && (
            <p className={`text-xs ${msg.ok ? "text-green-600" : "text-red-500"}`}>{msg.text}</p>
          )}
          <button
            type="submit"
            disabled={applying}
            className="text-xs bg-amber-600 text-white px-3 py-1.5 rounded hover:bg-amber-700 transition disabled:opacity-50"
          >
            {applying ? "提交中..." : "提交申请"}
          </button>
        </form>
      )}
    </div>
  );
}
