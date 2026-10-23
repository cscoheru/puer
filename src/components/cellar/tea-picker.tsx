"use client";

import { useEffect, useRef } from "react";
import { useTeaSearch } from "@/components/cellar/use-tea-search";

/**
 * 茶品选择器：搜茶品库（经典优先），找不到就自建。
 *
 * 走 `/api/cellar/teas`（茶仓专用），不复用全站共用的 `/api/teas` ——
 * 那个接口的排序与返回形状被发帖选茶等页面依赖，改它会波及那边。
 *
 * 搜索同时匹配 name、brand 与 aliases。查过生产库：今天的 aliases 全是
 * name 的副本（1686 款茶无一例外），所以这一项眼下等价于匹配 name；
 * 但它是唯一一处将来能放「班章」「老班章」这类俗称的地方 —— 现在接上，
 * 等站长补了真实别名就自动生效。
 */
export default function TeaPicker({
  onPick,
  onSelfBuild,
  autoFocus = false,
}: {
  onPick: (tea: import("@/components/cellar/use-tea-search").TeaOption) => void;
  onSelfBuild: () => void;
  autoFocus?: boolean;
}) {
  const { q, setQ, teas, searching, error } = useTeaSearch("/api/cellar/teas");
  const inputRef = useRef<HTMLInputElement>(null);

  // 弹窗里的输入框要自动获得焦点（HTML 的 autoFocus 属性在这里不生效）。
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div>
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜茶品名或别名（如「班章乔木」）"
        className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm bg-white"
      />

      {searching && <p className="text-xs text-stone-400 mt-2">搜索中…</p>}

      {error && (
        <p className="text-xs text-red-600 mt-2">
          {error}（这不是「没找到」，先别急着自建）
        </p>
      )}

      {!searching && !error && q.trim() && teas.length === 0 && (
        <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-sm text-amber-900 mb-2">
            茶品库里没有「{q.trim()}」。
          </p>
          <button
            onClick={onSelfBuild}
            className="px-3 py-1.5 text-sm bg-amber-700 text-white rounded hover:bg-amber-800"
          >
            自建这条茶（提交给站长并入茶品库）
          </button>
        </div>
      )}

      {teas.length > 0 && (
        <ul className="mt-2 max-h-64 overflow-y-auto border border-stone-200 rounded-lg divide-y divide-stone-100 bg-white">
          {teas.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => onPick(t)}
                className="w-full text-left px-3 py-2.5 hover:bg-amber-50 transition flex items-center gap-2"
              >
                <span className="text-sm text-stone-800">{t.name}</span>
                {t.brand && (
                  <span className="text-xs text-stone-400">{t.brand}</span>
                )}
                {t.year && (
                  <span className="text-xs text-stone-400">{t.year}</span>
                )}
                {t.isClassic && (
                  <span className="text-[0.65rem] px-1.5 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-700">
                    经典
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
