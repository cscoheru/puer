"use client";

import { useState, useTransition } from "react";

interface VoteButtonProps {
  refId: string;
  type: "article" | "comment";
  initialUpvotes: number;
  initialDownvotes: number;
  initialValue: number; // 1 = upvoted, -1 = downvoted, 0 = none
  size?: "sm" | "md";
}

export default function VoteButton({
  refId, type, initialUpvotes, initialDownvotes, initialValue, size = "md",
}: VoteButtonProps) {
  const [value, setValue] = useState(initialValue);
  const [upvotes, setUpvotes] = useState(initialUpvotes);
  const [downvotes, setDownvotes] = useState(initialDownvotes);
  const [pending, startTransition] = useTransition();
  const [loginHint, setLoginHint] = useState(false);

  const net = upvotes - downvotes;

  const handleVote = (newValue: number) => {
    if (loginHint) return;
    startTransition(async () => {
      const oldValue = value;
      const oldUpvotes = upvotes;
      const oldDownvotes = downvotes;

      if (newValue === oldValue) {
        setValue(0);
        setUpvotes((c) => c + (oldValue === 1 ? -1 : 0));
        setDownvotes((c) => c + (oldValue === -1 ? -1 : 0));
      } else {
        setValue(newValue);
        setUpvotes((c) => c + (newValue === 1 ? 1 : 0) - (oldValue === 1 ? 1 : 0));
        setDownvotes((c) => c + (newValue === -1 ? 1 : 0) - (oldValue === -1 ? 1 : 0));
      }

      try {
        const res = await fetch("/api/vote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refId, type, value: newValue === oldValue ? 0 : newValue }),
        });
        if (res.status === 401) {
          setValue(oldValue);
          setUpvotes(oldUpvotes);
          setDownvotes(oldDownvotes);
          setLoginHint(true);
          setTimeout(() => setLoginHint(false), 3000);
          return;
        }
        if (!res.ok) throw new Error("Failed");
      } catch {
        setValue(oldValue);
        setUpvotes(oldUpvotes);
        setDownvotes(oldDownvotes);
      }
    });
  };

  const isSm = size === "sm";
  const iconSize = isSm ? 18 : 22;
  const scoreSize = isSm ? "text-xs" : "text-sm";

  return (
    <div className={`relative inline-flex items-center gap-0.5 select-none ${isSm ? "" : ""}`}>
      {/* Upvote arrow */}
      <button
        type="button"
        onClick={() => handleVote(1)}
        disabled={pending}
        className={`flex items-center justify-center rounded transition-colors
          ${isSm ? "w-7 h-7" : "w-8 h-8"}
          ${value === 1
            ? "bg-orange-50 text-orange-500"
            : "text-stone-400 hover:bg-stone-100 hover:text-orange-400"
          }
          ${pending ? "opacity-50 cursor-wait" : "cursor-pointer"}`}
        title="推荐"
      >
        <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill={value === 1 ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 19V5" />
          <path d="M5 12l7-7 7 7" />
        </svg>
      </button>

      {/* Score */}
      <span className={`font-mono font-bold leading-none min-w-[24px] text-center tabular-nums ${
        net > 0 ? "text-orange-600" : net < 0 ? "text-blue-500" : "text-stone-400"
      } ${scoreSize}`}>
        {net}
      </span>

      {/* Downvote arrow */}
      <button
        type="button"
        onClick={() => handleVote(-1)}
        disabled={pending}
        className={`flex items-center justify-center rounded transition-colors
          ${isSm ? "w-7 h-7" : "w-8 h-8"}
          ${value === -1
            ? "bg-blue-50 text-blue-500"
            : "text-stone-400 hover:bg-stone-100 hover:text-blue-400"
          }
          ${pending ? "opacity-50 cursor-wait" : "cursor-pointer"}`}
        title="不推荐"
      >
        <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill={value === -1 ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14" />
          <path d="M19 12l-7 7-7-7" />
        </svg>
      </button>

      {/* Login hint overlay */}
      {loginHint && (
        <a
          href="/login"
          className="absolute -top-8 left-1/2 -translate-x-1/2 bg-stone-800 text-white text-xs px-2.5 py-1 rounded shadow-lg whitespace-nowrap z-50 hover:bg-stone-700"
        >
          登录后投票
          <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-stone-800 rotate-45" />
        </a>
      )}
    </div>
  );
}
