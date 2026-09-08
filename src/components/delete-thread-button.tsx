"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  articleId: string;
  boardSlug: string;
}

export default function DeleteThreadButton({ articleId, boardSlug }: Props) {
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();

  const handleDelete = async () => {
    if (!confirm("确定要删除这个帖子吗？此操作不可撤销。")) return;
    setDeleting(true);

    try {
      const res = await fetch(`/api/articles/${articleId}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "删除失败");
      }
      router.push(`/forum/${boardSlug}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "删除失败");
      setDeleting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleDelete}
      disabled={deleting}
      className="text-xs px-2.5 py-1.5 border border-red-200 text-red-600 rounded hover:bg-red-50 transition disabled:opacity-50"
    >
      {deleting ? "删除中..." : "删除"}
    </button>
  );
}
