"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import DraftReviewPanel, { type ReviewDraft, type SourceNote } from "./drafts-client";

export default function DraftsPage() {
  const { data: session } = useSession();
  const [drafts, setDrafts] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<{
    draft: ReviewDraft;
    sourceNote: SourceNote | null;
  } | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);

  useEffect(() => {
    fetchDrafts();
  }, [page]);

  const fetchDrafts = async () => {
    setLoading(true);
    const res = await fetch(`/api/drafts?page=${page}&limit=30`);
    const data = await res.json();
    setDrafts(data.drafts || []);
    setTotal(data.total || 0);
    setLoading(false);
  };

  const handlePublish = async (id: string) => {
    const res = await fetch("/api/drafts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status: "published" }),
    });
    if (res.ok) fetchDrafts();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定删除？")) return;
    const res = await fetch("/api/drafts", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) fetchDrafts();
  };

  // Open the full review panel: fetches the single draft + its read-only source
  // note (tasting drafts only) so the reviewer can verify provenance.
  const openReview = async (id: string) => {
    setReviewLoading(true);
    try {
      const res = await fetch(`/api/drafts?id=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error("加载失败");
      const data = await res.json();
      setSelected({ draft: data.draft, sourceNote: data.sourceNote ?? null });
    } catch {
      alert("加载草稿失败");
    } finally {
      setReviewLoading(false);
    }
  };

  if (session && (session.user as any).role !== "admin") {
    return <div className="text-center py-20 text-stone-400">仅管理员可访问</div>;
  }

  return (
    <div className="max-w-4xl mx-auto py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-serif font-bold text-stone-800">草稿管理</h1>
          <p className="text-sm text-stone-500 mt-1">共 {total} 篇草稿</p>
        </div>
        <a
          href="/admin/import"
          className="text-sm text-amber-700 hover:text-amber-900 font-medium"
        >
          导入更多 →
        </a>
      </div>

      {loading ? (
        <p className="text-center text-stone-400 py-10">加载中...</p>
      ) : drafts.length === 0 ? (
        <p className="text-center text-stone-400 py-10">暂无草稿</p>
      ) : (
        <div className="space-y-2">
          {drafts.map((d: any) => (
            <div
              key={d.id}
              className="flex items-center gap-3 p-3 bg-white rounded-lg border border-stone-200 hover:border-amber-200 transition"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-stone-800 truncate">{d.title}</p>
                <p className="text-xs text-stone-400 mt-0.5">
                  {d.type === "tasting" ? "品鉴" : d.type === "article" ? "文章" : "讨论"} ·{" "}
                  {new Date(d.createdAt).toLocaleDateString("zh-CN")} ·
                  {d.tags?.length > 0 && ` ${d.tags.slice(0, 3).join(", ")}`}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => openReview(d.id)}
                  disabled={reviewLoading}
                  className="text-xs bg-stone-100 text-stone-700 px-3 py-1.5 rounded-lg hover:bg-stone-200 transition disabled:opacity-50"
                >
                  {reviewLoading ? "…" : "审校"}
                </button>
                <button
                  onClick={() => handlePublish(d.id)}
                  className="text-xs bg-amber-100 text-amber-800 px-3 py-1.5 rounded-lg hover:bg-amber-200 transition"
                >
                  发布
                </button>
                <button
                  onClick={() => handleDelete(d.id)}
                  className="text-xs text-stone-400 hover:text-red-500 transition"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {total > 30 && (
        <div className="flex justify-center gap-2 mt-6">
          <button
            onClick={() => setPage(page - 1)}
            disabled={page === 1}
            className="px-3 py-1.5 text-sm border rounded-lg disabled:opacity-30"
          >
            上一页
          </button>
          <span className="px-3 py-1.5 text-sm text-stone-500">
            {page} / {Math.ceil(total / 30)}
          </span>
          <button
            onClick={() => setPage(page + 1)}
            disabled={page * 30 >= total}
            className="px-3 py-1.5 text-sm border rounded-lg disabled:opacity-30"
          >
            下一页
          </button>
        </div>
      )}

      {selected && (
        <DraftReviewPanel
          draft={selected.draft}
          sourceNote={selected.sourceNote}
          onClose={() => setSelected(null)}
          onChanged={fetchDrafts}
        />
      )}
    </div>
  );
}
