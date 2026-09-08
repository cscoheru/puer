"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

interface Article {
  id: string;
  title: string;
  status: string;
  isPinned: boolean;
  isEssence: boolean;
  viewCount: number;
  replyCount: number;
  createdAt: string;
  updatedAt: string;
  lastRepliedAt: string | null;
  author: { id: string; username: string; avatar: string | null };
  board: { id: string; name: string; slug: string } | null;
}

const PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "published", label: "已发布" },
  { value: "archived", label: "已归档" },
];

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    published: "bg-green-100 text-green-700",
    draft: "bg-yellow-100 text-yellow-700",
    archived: "bg-gray-100 text-gray-500",
  };
  const labels: Record<string, string> = {
    published: "已发布",
    draft: "草稿",
    archived: "已归档",
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || "bg-stone-100 text-stone-500"}`}>
      {labels[status] || status}
    </span>
  );
}

export default function ContentListPage() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [keyword, setKeyword] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchLoading, setBatchLoading] = useState(false);

  const fetchArticles = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (keyword) params.set("keyword", keyword);
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));

      const res = await fetch(`/api/admin/articles?${params}`);
      if (!res.ok) throw new Error("加载失败");
      const data = await res.json();
      setArticles(data.articles || []);
      setTotal(data.total || 0);
    } catch {
      setError("加载文章列表失败，请重试");
    } finally {
      setLoading(false);
    }
  }, [status, keyword, page]);

  useEffect(() => {
    fetchArticles();
  }, [fetchArticles]);

  // Reset selection when page/filters change
  useEffect(() => {
    setSelected(new Set());
  }, [page, status, keyword]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handleSearch = () => {
    setKeyword(searchInput);
    setPage(1);
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === articles.length && articles.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(articles.map((a) => a.id)));
    }
  };

  const handleBatch = async (action: string) => {
    if (selected.size === 0) return;
    const actionLabels: Record<string, string> = {
      archive: "归档",
      publish: "发布",
      delete: "删除",
      pin: "置顶",
      unpin: "取消置顶",
      essence: "加精",
      unessence: "取消加精",
    };
    if (action === "delete" && !confirm(`确定删除 ${selected.size} 篇文章？此操作不可撤销。`)) return;

    setBatchLoading(true);
    try {
      const res = await fetch("/api/admin/articles/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ articleIds: Array.from(selected), action }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "操作失败");
      } else {
        setSelected(new Set());
        fetchArticles();
      }
    } catch {
      setError("批量操作失败");
    } finally {
      setBatchLoading(false);
    }
  };

  const handleDeleteSingle = async (id: string) => {
    if (!confirm("确定删除？此操作不可撤销。")) return;
    try {
      const res = await fetch(`/api/admin/articles/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      fetchArticles();
    } catch {
      setError("删除失败");
    }
  };

  return (
    <div className="max-w-6xl mx-auto py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-serif font-bold text-stone-800">内容管理</h1>
          <p className="text-sm text-stone-500 mt-1">共 {total} 篇内容（不含草稿）</p>
        </div>
        <Link
          href="/admin/drafts"
          className="text-sm text-amber-700 hover:text-amber-900 border border-amber-200 hover:bg-amber-50 rounded-lg px-3 py-1.5 transition"
        >
          草稿审校 →
        </Link>
      </div>
      <p className="text-xs text-stone-400 -mt-4 mb-4">
        草稿的审校、编辑与发布在「草稿审校」中进行，本页仅管理已发布与已归档内容。
      </p>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-lg border border-stone-300 text-sm bg-white"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>

        <div className="flex items-center gap-1">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="搜索标题..."
            className="px-3 py-2 rounded-lg border border-stone-300 text-sm w-56"
          />
          <button
            onClick={handleSearch}
            className="px-3 py-2 bg-amber-800 text-white text-sm rounded-lg hover:bg-amber-900 transition"
          >
            搜索
          </button>
        </div>
      </div>

      {/* Batch action toolbar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <span className="text-sm text-amber-800 font-medium">已选 {selected.size} 篇</span>
          <div className="flex items-center gap-2 ml-4">
            <button
              onClick={() => handleBatch("archive")}
              disabled={batchLoading}
              className="px-3 py-1.5 text-xs bg-white border border-stone-300 rounded-lg hover:bg-stone-50 transition disabled:opacity-50"
            >
              归档
            </button>
            <button
              onClick={() => handleBatch("publish")}
              disabled={batchLoading}
              className="px-3 py-1.5 text-xs bg-white border border-stone-300 rounded-lg hover:bg-stone-50 transition disabled:opacity-50"
            >
              发布
            </button>
            <button
              onClick={() => handleBatch("pin")}
              disabled={batchLoading}
              className="px-3 py-1.5 text-xs bg-white border border-stone-300 rounded-lg hover:bg-stone-50 transition disabled:opacity-50"
            >
              置顶
            </button>
            <button
              onClick={() => handleBatch("unpin")}
              disabled={batchLoading}
              className="px-3 py-1.5 text-xs bg-white border border-stone-300 rounded-lg hover:bg-stone-50 transition disabled:opacity-50"
            >
              取消置顶
            </button>
            <button
              onClick={() => handleBatch("essence")}
              disabled={batchLoading}
              className="px-3 py-1.5 text-xs bg-white border border-stone-300 rounded-lg hover:bg-stone-50 transition disabled:opacity-50"
            >
              加精
            </button>
            <button
              onClick={() => handleBatch("unessence")}
              disabled={batchLoading}
              className="px-3 py-1.5 text-xs bg-white border border-stone-300 rounded-lg hover:bg-stone-50 transition disabled:opacity-50"
            >
              取消加精
            </button>
            <button
              onClick={() => handleBatch("delete")}
              disabled={batchLoading}
              className="px-3 py-1.5 text-xs bg-red-50 border border-red-200 text-red-600 rounded-lg hover:bg-red-100 transition disabled:opacity-50"
            >
              删除
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 text-sm text-red-700 bg-red-50 rounded-lg border border-red-200">
          {error}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="text-center py-16 text-stone-400 text-sm">加载中...</div>
      ) : articles.length === 0 ? (
        <div className="text-center py-16 text-stone-400 text-sm">暂无内容</div>
      ) : (
        <div className="border border-stone-200 rounded-lg overflow-hidden bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-stone-50 border-b border-stone-200">
                <th className="px-3 py-3 text-left w-10">
                  <input
                    type="checkbox"
                    checked={selected.size === articles.length && articles.length > 0}
                    onChange={toggleSelectAll}
                    className="rounded border-stone-300"
                  />
                </th>
                <th className="px-3 py-3 text-left font-medium text-stone-600">标题</th>
                <th className="px-3 py-3 text-left font-medium text-stone-600 w-24">作者</th>
                <th className="px-3 py-3 text-left font-medium text-stone-600 w-24">板块</th>
                <th className="px-3 py-3 text-left font-medium text-stone-600 w-20">状态</th>
                <th className="px-3 py-3 text-center font-medium text-stone-600 w-16">标</th>
                <th className="px-3 py-3 text-right font-medium text-stone-600 w-16">浏览</th>
                <th className="px-3 py-3 text-right font-medium text-stone-600 w-16">回复</th>
                <th className="px-3 py-3 text-left font-medium text-stone-600 w-32">发布时间</th>
                <th className="px-3 py-3 text-center font-medium text-stone-600 w-20">操作</th>
              </tr>
            </thead>
            <tbody>
              {articles.map((article) => (
                <tr key={article.id} className="border-b border-stone-100 hover:bg-stone-50 transition">
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(article.id)}
                      onChange={() => toggleSelect(article.id)}
                      className="rounded border-stone-300"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Link
                      href={`/admin/content/${article.id}`}
                      className="text-stone-800 hover:text-amber-700 font-medium transition line-clamp-1"
                    >
                      {article.title}
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-stone-600">{article.author?.username || "-"}</td>
                  <td className="px-3 py-3 text-stone-500">{article.board?.name || "-"}</td>
                  <td className="px-3 py-3"><StatusBadge status={article.status} /></td>
                  <td className="px-3 py-3 text-center">
                    {article.isPinned && <span className="text-amber-600 text-xs" title="置顶">&#128204;</span>}
                    {article.isEssence && <span className="text-red-500 text-xs ml-1" title="精华">&#11088;</span>}
                    {!article.isPinned && !article.isEssence && <span className="text-stone-300">-</span>}
                  </td>
                  <td className="px-3 py-3 text-right text-stone-500 tabular-nums">{article.viewCount}</td>
                  <td className="px-3 py-3 text-right text-stone-500 tabular-nums">{article.replyCount}</td>
                  <td className="px-3 py-3 text-stone-400">
                    {new Date(article.createdAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td className="px-3 py-3 text-center">
                    <button
                      onClick={() => handleDeleteSingle(article.id)}
                      className="text-xs text-stone-400 hover:text-red-500 transition"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center items-center gap-2 mt-6">
          <button
            onClick={() => setPage(page - 1)}
            disabled={page === 1}
            className="px-3 py-1.5 text-sm border border-stone-300 rounded-lg hover:bg-stone-50 transition disabled:opacity-30 disabled:cursor-not-allowed"
          >
            上一页
          </button>
          <span className="px-3 py-1.5 text-sm text-stone-500">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage(page + 1)}
            disabled={page >= totalPages}
            className="px-3 py-1.5 text-sm border border-stone-300 rounded-lg hover:bg-stone-50 transition disabled:opacity-30 disabled:cursor-not-allowed"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}
