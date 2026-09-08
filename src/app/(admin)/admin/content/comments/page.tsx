"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

interface Comment {
  id: string;
  content: string;
  createdAt: string;
  likesCount: number;
  author: { id: string; username: string; avatar: string | null };
  article: { id: string; title: string } | null;
}

const PAGE_SIZE = 20;

export default function CommentsPage() {
  const [comments, setComments] = useState<Comment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchComments = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (keyword) params.set("keyword", keyword);
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));

      const res = await fetch(`/api/admin/comments?${params}`);
      if (!res.ok) throw new Error("加载失败");
      const data = await res.json();
      setComments(data.comments || []);
      setTotal(data.total || 0);
    } catch {
      setError("加载评论列表失败，请重试");
    } finally {
      setLoading(false);
    }
  }, [keyword, page]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handleSearch = () => {
    setKeyword(searchInput);
    setPage(1);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定删除此评论？")) return;
    setDeletingId(id);
    try {
      const res = await fetch("/api/admin/comments", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error();
      setComments((prev) => prev.filter((c) => c.id !== id));
      setTotal((prev) => prev - 1);
    } catch {
      setError("删除评论失败");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-serif font-bold text-stone-800">评论管理</h1>
          <p className="text-sm text-stone-500 mt-1">共 {total} 条评论</p>
        </div>
        <Link
          href="/admin/content"
          className="text-sm text-amber-700 hover:text-amber-900 font-medium"
        >
          &larr; 返回内容列表
        </Link>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 mb-4">
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="搜索评论内容..."
          className="px-3 py-2 rounded-lg border border-stone-300 text-sm w-64"
        />
        <button
          onClick={handleSearch}
          className="px-3 py-2 bg-amber-800 text-white text-sm rounded-lg hover:bg-amber-900 transition"
        >
          搜索
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 text-sm text-red-700 bg-red-50 rounded-lg border border-red-200">
          {error}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="text-center py-16 text-stone-400 text-sm">加载中...</div>
      ) : comments.length === 0 ? (
        <div className="text-center py-16 text-stone-400 text-sm">暂无评论</div>
      ) : (
        <div className="border border-stone-200 rounded-lg overflow-hidden bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-stone-50 border-b border-stone-200">
                <th className="px-3 py-3 text-left font-medium text-stone-600">内容</th>
                <th className="px-3 py-3 text-left font-medium text-stone-600 w-24">作者</th>
                <th className="px-3 py-3 text-left font-medium text-stone-600 w-40">所属文章</th>
                <th className="px-3 py-3 text-right font-medium text-stone-600 w-16">赞</th>
                <th className="px-3 py-3 text-left font-medium text-stone-600 w-36">时间</th>
                <th className="px-3 py-3 text-center font-medium text-stone-600 w-16">操作</th>
              </tr>
            </thead>
            <tbody>
              {comments.map((comment) => (
                <tr key={comment.id} className="border-b border-stone-100 hover:bg-stone-50 transition">
                  <td className="px-3 py-3">
                    <span className="text-stone-700 line-clamp-2">{comment.content}</span>
                  </td>
                  <td className="px-3 py-3 text-stone-600">{comment.author?.username || "-"}</td>
                  <td className="px-3 py-3">
                    {comment.article ? (
                      <Link
                        href={`/admin/content/${comment.article.id}`}
                        className="text-amber-700 hover:text-amber-900 hover:underline transition line-clamp-1"
                      >
                        {comment.article.title}
                      </Link>
                    ) : (
                      <span className="text-stone-400">-</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right text-stone-500 tabular-nums">{comment.likesCount}</td>
                  <td className="px-3 py-3 text-stone-400">
                    {new Date(comment.createdAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td className="px-3 py-3 text-center">
                    <button
                      onClick={() => handleDelete(comment.id)}
                      disabled={deletingId === comment.id}
                      className="text-xs text-stone-400 hover:text-red-500 transition disabled:opacity-50"
                    >
                      {deletingId === comment.id ? "..." : "删除"}
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
