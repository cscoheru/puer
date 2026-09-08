"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function SearchBar() {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    router.push(`/forum/search?q=${encodeURIComponent(q)}`);
    inputRef.current?.blur();
  };

  // Keyboard shortcut: Ctrl+K or Cmd+K to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <form onSubmit={handleSubmit} className="relative flex-1 max-w-xl">
      <div className={`relative flex items-center transition-all duration-200 ${focused ? "ring-2 ring-amber-300 border-amber-400" : ""}`}>
        <svg className="absolute left-3 w-4 h-4 text-stone-400 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="搜索帖子..."
          className="w-full pl-9 pr-10 py-2 text-sm bg-stone-100 border border-stone-200 rounded-full outline-none text-stone-700 placeholder:text-stone-400 transition"
        />
        <kbd className="absolute right-3 hidden md:inline-flex items-center px-1.5 py-0.5 text-xs text-stone-400 bg-white border border-stone-200 rounded">
          ⌘K
        </kbd>
      </div>
    </form>
  );
}
