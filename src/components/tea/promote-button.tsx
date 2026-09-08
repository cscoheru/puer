"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface PromoteButtonProps {
  tastingNoteId: string;
  tastingNoteTitle: string;
}

export default function PromoteButton({ tastingNoteId, tastingNoteTitle }: PromoteButtonProps) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handlePromote = async () => {
    const ok = confirm(`确定将"${tastingNoteTitle}"升级为独立茶品？\n\n将创建一个新的茶品并移除此品鉴笔记。`);
    if (!ok) return;

    setLoading(true);
    try {
      const res = await fetch("/api/admin/tasting-notes/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tastingNoteId }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "操作失败");
        return;
      }
      const data = await res.json();
      router.refresh();
      setTimeout(() => {
        window.location.href = `/tea/${data.newTeaId}`;
      }, 100);
    } catch {
      alert("操作失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handlePromote}
      disabled={loading}
      className="text-xs text-amber-600 hover:text-amber-800 border border-amber-300 px-2 py-1 rounded hover:bg-amber-50 transition disabled:opacity-50"
    >
      {loading ? "处理中..." : "升级为茶品"}
    </button>
  );
}
