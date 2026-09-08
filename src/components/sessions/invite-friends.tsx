"use client";

import { useState, useRef } from "react";
import OnlineStatusIndicator from "../online-status-indicator";

interface UserResult {
  id: string;
  username: string;
  avatar: string | null;
  level: number;
  onlineStatus: string;
}

interface Props {
  selected: string[];
  onChange: (userIds: string[]) => void;
  min?: number;
}

export default function InviteFriends({ selected, onChange, min = 2 }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserResult[]>([]);
  const [searching, setSearching] = useState(false);
  const userCache = useRef<Map<string, UserResult>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const search = async (q: string) => {
    if (q.length < 1) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = await res.json();
        const users: UserResult[] = data.users || [];
        users.forEach((u) => userCache.current.set(u.id, u));
        setResults(users);
      }
    } catch {
      // silent
    } finally {
      setSearching(false);
    }
  };

  const toggle = (userId: string) => {
    onChange(
      selected.includes(userId)
        ? selected.filter((id) => id !== userId)
        : [...selected, userId]
    );
  };

  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium text-stone-700">
        邀请茶友 <span className="text-red-500">*</span>
        <span className="text-xs text-stone-400 ml-1">（至少 {min} 人）</span>
      </label>

      {/* Selected chips */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((id) => {
            const u = userCache.current.get(id);
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 px-2 py-1 bg-amber-100 text-amber-800 rounded-full text-xs"
              >
                {u?.username || id.slice(0, 8)}
                <button type="button" onClick={() => toggle(id)} className="hover:text-red-500 ml-0.5">
                  ✕
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Search input */}
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => search(e.target.value), 300);
        }}
        placeholder="搜索用户名..."
        className="w-full px-3 py-2 border border-amber-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400 text-sm"
      />

      {/* Results */}
      {searching && <p className="text-xs text-stone-400">搜索中...</p>}
      {results.length > 0 && (
        <div className="max-h-48 overflow-y-auto border border-amber-100 rounded-lg divide-y divide-amber-50">
          {results.map((user) => (
            <button
              key={user.id}
              type="button"
              onClick={() => toggle(user.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left transition text-sm ${
                selected.includes(user.id) ? "bg-amber-50" : "hover:bg-stone-50"
              }`}
            >
              <img
                src={user.avatar || "/default-avatar.svg"}
                alt=""
                className="w-7 h-7 rounded-full object-cover"
              />
              <span className="flex-1 min-w-0">
                <span className="font-medium text-stone-700">{user.username}</span>
                <span className="text-stone-400 ml-1">Lv.{user.level}</span>
              </span>
              <OnlineStatusIndicator status={user.onlineStatus} />
              {selected.includes(user.id) && (
                <span className="text-amber-600 text-xs font-medium">已选</span>
              )}
            </button>
          ))}
        </div>
      )}

      {results.length === 0 && query.length > 0 && !searching && (
        <p className="text-xs text-stone-400">未找到用户</p>
      )}

      {selected.length < min && (
        <p className="text-xs text-red-500">至少选择 {min} 位茶友</p>
      )}
    </div>
  );
}
