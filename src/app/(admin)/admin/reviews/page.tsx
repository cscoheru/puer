"use client";

import { useState, useEffect } from "react";

interface ReviewItem {
  kind: "article" | "comment";
  id: string;
  preview: string;
  type?: string;
  articleId?: string | null;
  articleTitle?: string | null;
  tastingNoteId?: string | null;
  author: { id: string; username: string; avatar?: string | null };
  createdAt: string;
  moderation: {
    categories?: string[];
    confidence?: number;
    reason?: string;
    source?: string;
  } | null;
}

const CATEGORY_MAP: Record<string, { label: string; className: string }> = {
  adult: { label: "涉黄", className: "bg-red-100 text-red-700" },
  gambling: { label: "赌博", className: "bg-red-100 text-red-700" },
  drug: { label: "毒品", className: "bg-red-100 text-red-700" },
  political: { label: "政治敏感", className: "bg-orange-100 text-orange-700" },
  investment: { label: "投资引流", className: "bg-orange-100 text-orange-700" },
  general: { label: "其他", className: "bg-stone-100 text-stone-600" },
};

const SOURCE_MAP: Record<string, string> = {
  keyword: "敏感词",
  ai: "AI",
  fallback: "故障兜底",
};

export default function ReviewsPage() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [kindFilter, setKindFilter] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [rejectModal, setRejectModal] = useState<ReviewItem | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [message, setMessage] = useState("");
  const limit = 20;

  useEffect(() => {
    fetchReviews();
  }, [page, kindFilter]);

  const fetchReviews = async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (kindFilter) params.set("kind", kindFilter);
    try {
      const res = await fetch(`/api/admin/reviews?${params}`);
      const data = await res.json();
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (item: ReviewItem) => {
    setActionLoading(item.id);
    try {
      const res = await fetch(`/api/admin/reviews/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve", kind: item.kind }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage(item.kind === "article" ? "已通过,帖子已发布" : "已通过,评论已发布");
        fetchReviews();
      } else {
        setMessage(data.error || "操作失败");
      }
    } catch {
      setMessage("操作失败");
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async () => {
    if (!rejectModal) return;
    setActionLoading(rejectModal.id);
    try {
      const res = await fetch(`/api/admin/reviews/${rejectModal.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject", kind: rejectModal.kind, reason: rejectReason || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage(rejectModal.kind === "article" ? "已拒绝,帖子已归档" : "已拒绝,评论已隐藏");
        setRejectModal(null);
        setRejectReason("");
        fetchReviews();
      } else {
        setMessage(data.error || "操作失败");
      }
    } catch {
      setMessage("操作失败");
    } finally {
      setActionLoading(null);
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="max-w-6xl mx-auto py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-serif font-bold text-stone-800">内容审核</h1>
        <p className="text-sm text-stone-500 mt-1">
          共 {total} 条待审(AI 预审标记为可疑或 AI 故障转人工的内容)
        </p>
      </div>

      {message && (
        <p className="mb-4 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">{message}</p>
      )}

      {/* 类型筛选 */}
      <div className="flex items-center gap-3 mb-4">
        <select
          value={kindFilter}
          onChange={(e) => {
            setKindFilter(e.target.value);
            setPage(1);
          }}
          className="text-sm border border-stone-200 rounded-lg px-3 py-1.5 bg-white text-stone-700 focus:outline-none"
        >
          <option value="">全部</option>
          <option value="article">帖子</option>
          <option value="comment">评论</option>
        </select>
      </div>

      {loading ? (
        <p className="text-center text-stone-400 py-10">加载中...</p>
      ) : items.length === 0 ? (
        <p className="text-center text-stone-400 py-10">🎉 队列为空,没有待审内容</p>
      ) : (
        <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50">
                <th className="text-left px-4 py-3 text-stone-600 font-medium">类型</th>
                <th className="text-left px-4 py-3 text-stone-600 font-medium">内容预览</th>
                <th className="text-left px-4 py-3 text-stone-600 font-medium">作者</th>
                <th className="text-left px-4 py-3 text-stone-600 font-medium">审核信息</th>
                <th className="text-left px-4 py-3 text-stone-600 font-medium">时间</th>
                <th className="text-right px-4 py-3 text-stone-600 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const cats = item.moderation?.categories ?? [];
                return (
                  <tr key={`${item.kind}:${item.id}`} className="border-b border-stone-100 hover:bg-stone-50 transition align-top">
                    <td className="px-4 py-3">
                      <span className="inline-block px-2 py-0.5 rounded text-xs bg-stone-100 text-stone-600">
                        {item.kind === "article" ? "帖子" : "评论"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-stone-700 max-w-[280px]">
                      <p className="line-clamp-2 break-words" title={item.preview}>
                        {item.preview}
                      </p>
                      {item.kind === "comment" && item.articleTitle && (
                        <p className="text-xs text-stone-400 mt-1 truncate">
                          回复帖子：{item.articleTitle}
                        </p>
                      )}
                      <a
                        href={
                          item.kind === "article"
                            ? `/forum/thread/${item.id}`
                            : item.articleId
                              ? `/forum/thread/${item.articleId}`
                              : "#"
                        }
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-amber-700 hover:underline mt-1 inline-block"
                      >
                        查看原帖 →
                      </a>
                    </td>
                    <td className="px-4 py-3 text-stone-700">{item.author.username}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1 mb-1">
                        {cats.length ? (
                          cats.map((c) => {
                            const m = CATEGORY_MAP[c] || CATEGORY_MAP.general;
                            return (
                              <span key={c} className={`inline-block px-2 py-0.5 rounded text-xs ${m.className}`}>
                                {m.label}
                              </span>
                            );
                          })
                        ) : (
                          <span className="text-xs text-stone-400">AI 把握不足</span>
                        )}
                      </div>
                      {item.moderation?.reason && (
                        <p className="text-xs text-stone-500" title={item.moderation.reason}>
                          {item.moderation.reason}
                          {item.moderation.source && (
                            <span className="text-stone-400"> · {SOURCE_MAP[item.moderation.source] || item.moderation.source}</span>
                          )}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-stone-400 text-xs whitespace-nowrap">
                      {new Date(item.createdAt).toLocaleString("zh-CN")}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleApprove(item)}
                          disabled={actionLoading === item.id}
                          className="px-2 py-1 text-xs text-green-700 hover:bg-green-50 rounded transition disabled:opacity-50"
                        >
                          通过
                        </button>
                        <button
                          onClick={() => {
                            setRejectModal(item);
                            setRejectReason("");
                          }}
                          disabled={actionLoading === item.id}
                          className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded transition disabled:opacity-50"
                        >
                          拒绝
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-6">
          <button
            onClick={() => setPage(page - 1)}
            disabled={page === 1}
            className="px-3 py-1.5 text-sm border border-stone-200 rounded-lg hover:bg-stone-50 disabled:opacity-30"
          >
            上一页
          </button>
          <span className="px-3 py-1.5 text-sm text-stone-500">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage(page + 1)}
            disabled={page >= totalPages}
            className="px-3 py-1.5 text-sm border border-stone-200 rounded-lg hover:bg-stone-50 disabled:opacity-30"
          >
            下一页
          </button>
        </div>
      )}

      {/* 拒绝弹窗 */}
      {rejectModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setRejectModal(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-stone-800 mb-3">
              拒绝{rejectModal.kind === "article" ? "帖子" : "评论"}
            </h3>
            <div className="p-3 bg-stone-50 rounded-lg mb-4 text-sm">
              <p className="text-stone-600 line-clamp-3 break-words">{rejectModal.preview}</p>
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-stone-700 mb-1">拒绝原因(可选,会通知作者)</label>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="如:含违规内容..."
                className="w-full text-sm border border-stone-200 rounded-lg px-3 py-2 resize-none h-16 focus:outline-none focus:ring-1 focus:ring-amber-300"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setRejectModal(null)} className="px-3 py-1.5 text-sm text-stone-500 hover:text-stone-700">
                取消
              </button>
              <button
                onClick={handleReject}
                disabled={actionLoading !== null}
                className="px-4 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {actionLoading ? "处理中..." : "确认拒绝"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
