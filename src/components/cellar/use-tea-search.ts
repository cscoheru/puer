"use client";

import { useEffect, useState } from "react";

/**
 * 选茶的搜索（去抖 + 拉取）。
 *
 * 三处要用：用户添加茶、后台并入茶品、后台代录。三处各写一遍去抖
 * 效果器必然漂移 —— 而且它们**指向的接口不一样**（用户接口要登录、
 * 后台接口要 `cellar:manage` 权限），所以接口路径要能传。
 *
 * 关键：**非 2xx 不能当成「没搜到」**。401/403/404 的响应体里没有
 * `teas` 字段，当成空结果的话，界面会跟用户说「茶品库里没有这款茶」
 * 并给出「自建一条」按钮 —— 而真实原因是没登录或没权限。引导用户
 * 去自建一个重复的条目，比报错更糟。
 */
export interface TeaOption {
  id: string;
  name: string;
  brand: string | null;
  year: number | null;
  type: string | null;
  isClassic?: boolean;
}

export function useTeaSearch(endpoint: string) {
  const [q, setQ] = useState("");
  const [teas, setTeas] = useState<TeaOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setTeas([]);
      setError("");
      return;
    }
    setSearching(true);
    // 300ms 去抖：避免每敲一个字就打一次库。
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `${endpoint}?q=${encodeURIComponent(term)}`,
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setTeas([]);
          setError(data.error || "搜索失败");
          return;
        }
        setError("");
        setTeas(Array.isArray(data.teas) ? data.teas : []);
      } catch {
        setTeas([]);
        setError("搜索失败");
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q, endpoint]);

  return { q, setQ, teas, searching, error };
}
