"use client";

import { useState } from "react";

/**
 * P2-R5 跟进帖「升级到首页」按钮（toggle articles.promotedHomeAt）。
 * 仅经典普洱跟进帖渲染；作者/管理员/Lv.3+ 可操作（API 侧同样校验）。
 */
export default function PromoteHomeButton({
  boardSlug,
  articleId,
  initialPromoted,
}: {
  boardSlug: string;
  articleId: string;
  initialPromoted: boolean;
}) {
  const [promoted, setPromoted] = useState(initialPromoted);
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/boards/${boardSlug}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ articleId }),
      });
      if (res.ok) {
        const data = (await res.json()) as { isPromoted?: boolean };
        setPromoted(!!data.isPromoted);
      }
    } catch {
      /* 网络错误时保持原状态，用户可重试 */
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      title={promoted ? "取消升级后，该帖仅在茶品档案与经典普洱区内可见" : "升级后该帖进入论坛首页信息流"}
      className={`px-2.5 py-1.5 border rounded transition text-xs ${
        promoted
          ? "border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100"
          : "border-amber-300 text-amber-800 hover:bg-amber-50"
      } disabled:opacity-50`}
    >
      {promoted ? "🏠 已进首页 · 取消升级" : "🚀 升级到首页"}
    </button>
  );
}
