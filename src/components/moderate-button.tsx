"use client";

import { useState } from "react";

interface Props {
  boardSlug: string;
  articleId: string;
  action: "pin" | "essence";
  initialLabel: string;
}

export default function ModerateButton({ boardSlug, articleId, action, initialLabel }: Props) {
  const [label, setLabel] = useState(initialLabel);

  const handleClick = async () => {
    const res = await fetch(`/api/boards/${boardSlug}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ articleId }),
    });
    if (res.ok) {
      const data = await res.json();
      const isActive: boolean = data[`is${action.charAt(0).toUpperCase()}${action.slice(1)}`];
      if (action === "pin") {
        setLabel(isActive ? "取消置顶" : "置顶");
      } else {
        setLabel(isActive ? "取消精华" : "精华");
      }
    }
  };

  return (
    <button onClick={handleClick} className="text-xs text-stone-500 hover:text-amber-700 border border-stone-300 px-2.5 py-1 rounded-lg hover:border-amber-300 transition">
      {label}
    </button>
  );
}
