"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

interface HotArticle {
  id: string;
  title: string;
  upvotes: number;
  downvotes: number;
  replyCount: number;
  viewCount: number;
  createdAt: string;
  hotScore: number;
  hotOverride: string | null;
  hotSortOrder: number | null;
  author: { username: string };
  board: { name: string } | null;
}

export default function HotManagementPage() {
  const [pinned, setPinned] = useState<HotArticle[]>([]);
  const [auto, setAuto] = useState<HotArticle[]>([]);
  const [demoted, setDemoted] = useState<HotArticle[]>([]);
  const [searchResults, setSearchResults] = useState<HotArticle[]>([]);
  const [searchQ, setSearchQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showDemoted, setShowDemoted] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/hot");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setPinned(data.pinned || []);
      setAuto(data.auto || []);
      setDemoted(data.demoted || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const doSearch = useCallback(async () => {
    if (!searchQ.trim()) { setSearchResults([]); return; }
    try {
      const res = await fetch(`/api/admin/hot?q=${encodeURIComponent(searchQ.trim())}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch {
      setSearchResults([]);
    }
  }, [searchQ]);

  useEffect(() => {
    const t = setTimeout(doSearch, 300);
    return () => clearTimeout(t);
  }, [doSearch]);

  const performAction = async (articleId: string, action: string, sortOrder?: number) => {
    setActionLoading(articleId);
    try {
      const res = await fetch("/api/admin/hot", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ articleId, action, sortOrder }),
      });
      if (!res.ok) throw new Error();
      await fetchData();
      if (searchQ) doSearch();
    } catch {
      /* ignore */
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return <div className="text-center py-20 text-stone-400 text-sm">加载中...</div>;
  }

  return (
    <div className="max-w-6xl mx-auto py-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-serif font-bold text-stone-800">热榜管理</h1>
        <span className="text-xs text-stone-400">手动 pinned 帖排在算法帖之前</span>
      </div>

      <div className="flex gap-6">
        {/* Left: Hot ranking */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Pinned section */}
          {pinned.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-amber-700 mb-2">📌 手动置顶 ({pinned.length})</h2>
              <div className="space-y-1">
                {pinned.map((a, i) => (
                  <HotItem
                    key={a.id}
                    article={a}
                    rank={i + 1}
                    source="pinned"
                    loading={actionLoading === a.id}
                    onDemote={() => performAction(a.id, "demote")}
                    onUnpin={() => performAction(a.id, "unpin")}
                    onMoveUp={i > 0 ? () => performAction(a.id, "reorder", (pinned[i - 1].hotSortOrder || 0) + 1) : undefined}
                    onMoveDown={i < pinned.length - 1 ? () => performAction(a.id, "reorder", (pinned[i + 1].hotSortOrder || 0) - 1) : undefined}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Auto section */}
          <div>
            <h2 className="text-sm font-medium text-stone-600 mb-2">🔥 算法排行 ({auto.length})</h2>
            <div className="space-y-1">
              {auto.map((a, i) => (
                <HotItem
                  key={a.id}
                  article={a}
                  rank={pinned.length + i + 1}
                  source="auto"
                  loading={actionLoading === a.id}
                  onPin={() => performAction(a.id, "pin", 100 - pinned.length)}
                  onDemote={() => performAction(a.id, "demote")}
                />
              ))}
              {auto.length === 0 && <p className="text-sm text-stone-400 py-4">暂无算法推荐帖</p>}
            </div>
          </div>

          {/* Demoted section */}
          {demoted.length > 0 && (
            <div>
              <button onClick={() => setShowDemoted((v) => !v)} className="text-sm text-stone-400 hover:text-stone-600 mb-2">
                {showDemoted ? "▼" : "▶"} 已下架 ({demoted.length})
              </button>
              {showDemoted && (
                <div className="space-y-1">
                  {demoted.map((a, i) => (
                    <HotItem
                      key={a.id}
                      article={a}
                      rank={-1}
                      source="demoted"
                      loading={actionLoading === a.id}
                      onRestore={() => performAction(a.id, "restore")}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: Search + pin */}
        <div className="w-80 shrink-0 space-y-4">
          <div className="bg-white border border-stone-200 rounded-lg p-4">
            <h3 className="text-sm font-medium text-stone-700 mb-3">搜索帖子上架</h3>
            <input
              type="text"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="输入标题关键词..."
              className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400 mb-3"
            />
            {searchResults.length > 0 && (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {searchResults.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 p-2 border border-stone-100 rounded text-sm">
                    <div className="flex-1 min-w-0">
                      <Link href={`/admin/content/${a.id}`} className="text-stone-700 hover:text-amber-700 line-clamp-1" target="_blank">
                        {a.title}
                      </Link>
                      <div className="text-xs text-stone-400">{a.author.username} · {a.board?.name || "-"}</div>
                    </div>
                    {a.hotOverride === "pinned" ? (
                      <span className="text-xs text-amber-600 shrink-0">已置顶</span>
                    ) : a.hotOverride === "demoted" ? (
                      <button
                        onClick={() => performAction(a.id, "restore")}
                        disabled={actionLoading === a.id}
                        className="px-2 py-1 text-xs bg-green-50 text-green-600 rounded hover:bg-green-100 shrink-0 disabled:opacity-50"
                      >恢复</button>
                    ) : (
                      <button
                        onClick={() => performAction(a.id, "pin", 100 - pinned.length)}
                        disabled={actionLoading === a.id}
                        className="px-2 py-1 text-xs bg-amber-50 text-amber-700 rounded hover:bg-amber-100 shrink-0 disabled:opacity-50"
                      >上架</button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {searchQ && searchResults.length === 0 && (
              <p className="text-xs text-stone-400">无搜索结果</p>
            )}
          </div>

          {/* Legend */}
          <div className="bg-white border border-stone-200 rounded-lg p-4">
            <h3 className="text-sm font-medium text-stone-700 mb-2">说明</h3>
            <div className="text-xs text-stone-500 space-y-1.5">
              <p><span className="text-amber-600">置顶</span>：固定在热榜顶部，按权重排序</p>
              <p><span className="text-stone-400">下架</span>：从热榜移除，仍出现在最新列表</p>
              <p><span className="text-green-600">恢复</span>：恢复为算法自动排名</p>
              <p>手动帖始终排在算法帖之前</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function HotItem({ article: a, rank, source, loading, onPin, onDemote, onUnpin, onRestore, onMoveUp, onMoveDown }: {
  article: HotArticle;
  rank: number;
  source: "pinned" | "auto" | "demoted";
  loading: boolean;
  onPin?: () => void;
  onDemote?: () => void;
  onUnpin?: () => void;
  onRestore?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const isPinned = source === "pinned";
  const isDemoted = source === "demoted";

  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg border text-sm transition ${isDemoted ? "bg-stone-50 border-stone-100 opacity-60" : "bg-white border-stone-200"}`}>
      <span className={`w-6 text-center font-mono text-xs shrink-0 ${isPinned ? "text-amber-600 font-bold" : "text-stone-400"}`}>
        {rank > 0 ? rank : "–"}
      </span>
      <div className="flex-1 min-w-0">
        <Link href={`/admin/content/${a.id}`} className="text-stone-700 hover:text-amber-700 line-clamp-1 font-medium" target="_blank">
          {a.title}
        </Link>
        <div className="text-xs text-stone-400 mt-0.5">
          {a.author.username} · {a.board?.name || "-"} · {a.hotScore}分 · 👍{a.upvotes} 💬{a.replyCount}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {isPinned && (
          <>
            {onMoveUp && <button onClick={onMoveUp} disabled={loading} className="px-1.5 py-1 text-xs text-stone-400 hover:text-stone-600 disabled:opacity-50" title="上移">↑</button>}
            {onMoveDown && <button onClick={onMoveDown} disabled={loading} className="px-1.5 py-1 text-xs text-stone-400 hover:text-stone-600 disabled:opacity-50" title="下移">↓</button>}
            <button onClick={onUnpin} disabled={loading} className="px-2 py-1 text-xs border border-stone-300 rounded hover:bg-stone-50 disabled:opacity-50">取消置顶</button>
            <button onClick={onDemote} disabled={loading} className="px-2 py-1 text-xs bg-red-50 text-red-500 rounded hover:bg-red-100 disabled:opacity-50">下架</button>
          </>
        )}
        {source === "auto" && (
          <>
            <button onClick={onPin} disabled={loading} className="px-2 py-1 text-xs bg-amber-50 text-amber-700 rounded hover:bg-amber-100 disabled:opacity-50">置顶</button>
            <button onClick={onDemote} disabled={loading} className="px-2 py-1 text-xs bg-red-50 text-red-500 rounded hover:bg-red-100 disabled:opacity-50">下架</button>
          </>
        )}
        {isDemoted && (
          <button onClick={onRestore} disabled={loading} className="px-2 py-1 text-xs bg-green-50 text-green-600 rounded hover:bg-green-100 disabled:opacity-50">恢复</button>
        )}
      </div>
    </div>
  );
}
