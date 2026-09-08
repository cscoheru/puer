"use client";

import { useCallback, useEffect, useState } from "react";

interface TeaReview {
  id: string;
  question: string;
  imageUrls: string[];
  source: string;
  aiVerdict: string | null;
  aiConfidence: number | null;
  aiSkuName: string | null;
  aiAnswer: string | null;
  status: string;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
  user: { username: string; nickname: string | null } | null;
}

const VERDICT_LABEL: Record<string, string> = {
  same_product: "同款",
  same_series_variant: "同系列不同版",
  different_product: "不同款",
  uncertain: "无法判定",
};

export default function TeaReviewsAdminPage() {
  const [reviews, setReviews] = useState<TeaReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("pending");
  const [answering, setAnswering] = useState<TeaReview | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const fetchReviews = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/tea-reviews?status=${statusFilter}`);
      const data = await res.json();
      setReviews(data.reviews ?? []);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  const submitNote = async () => {
    if (!answering || !note.trim() || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch(`/api/admin/tea-reviews/${answering.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewNote: note.trim() }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "提交失败");
      setMessage("鉴定意见已回复");
      setAnswering(null);
      setNote("");
      fetchReviews();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "提交失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-stone-800">茶图人工鉴定</h1>
        <div className="flex gap-2">
          {(["pending", "reviewed", "all"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-sm ${
                statusFilter === s
                  ? "bg-amber-600 text-white"
                  : "bg-stone-100 text-stone-600 hover:bg-stone-200"
              }`}
            >
              {s === "pending" ? "待审" : s === "reviewed" ? "已回复" : "全部"}
            </button>
          ))}
        </div>
      </div>

      {message && (
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm px-4 py-2">
          {message}
        </div>
      )}

      {loading ? (
        <div className="text-center text-stone-400 py-12">加载中…</div>
      ) : reviews.length === 0 ? (
        <div className="rounded-2xl border border-stone-100 bg-white p-10 text-center text-stone-400 text-sm">
          暂无{statusFilter === "pending" ? "待审" : ""}鉴定单
        </div>
      ) : (
        <div className="space-y-4">
          {reviews.map((r) => (
            <div key={r.id} className="bg-white rounded-2xl border border-stone-100 shadow-sm p-4">
              <div className="flex items-start gap-4">
                <div className="flex gap-2 shrink-0">
                  {r.imageUrls.slice(0, 3).map((u, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={i}
                      src={u}
                      alt=""
                      className="w-20 h-20 object-cover rounded-lg border border-stone-200 cursor-zoom-in"
                      onClick={() => window.open(u, "_blank")}
                    />
                  ))}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-stone-800">{r.question}</p>
                  <div className="flex items-center gap-2 flex-wrap mt-1 text-xs text-stone-400">
                    <span>@{r.user?.nickname || r.user?.username || "?"}</span>
                    <span>{r.source === "auto" ? "低置信自动送审" : "用户手动提交"}</span>
                    {r.aiVerdict && (
                      <span className="text-stone-500">
                        AI: {VERDICT_LABEL[r.aiVerdict] ?? r.aiVerdict}
                        {r.aiSkuName ? `（${r.aiSkuName}）` : ""}
                        {r.aiConfidence != null ? ` ${Math.round(r.aiConfidence * 100)}%` : ""}
                      </span>
                    )}
                    <span>{new Date(r.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
                  </div>
                  {r.aiAnswer && (
                    <details className="mt-2">
                      <summary className="text-xs text-stone-400 cursor-pointer">AI 回答原文</summary>
                      <div className="mt-1 text-xs text-stone-500 whitespace-pre-wrap max-h-48 overflow-y-auto">
                        {r.aiAnswer}
                      </div>
                    </details>
                  )}
                </div>
                <div className="shrink-0">
                  {r.status === "pending" ? (
                    <button
                      onClick={() => {
                        setAnswering(r);
                        setNote(r.reviewNote ?? "");
                        setMessage("");
                      }}
                      className="px-4 py-2 text-sm rounded-lg bg-amber-600 text-white hover:bg-amber-700"
                    >
                      回复鉴定意见
                    </button>
                  ) : (
                    <span className="text-xs px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                      已回复 {r.reviewedAt ? new Date(r.reviewedAt).toLocaleDateString("zh-CN") : ""}
                    </span>
                  )}
                </div>
              </div>
              {r.status === "reviewed" && r.reviewNote && (
                <div className="mt-3 rounded-xl bg-emerald-50/70 border border-emerald-100 p-3 text-sm text-stone-700 whitespace-pre-wrap">
                  {r.reviewNote}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 回复弹层 */}
      {answering && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-xl w-full p-5 space-y-3">
            <h2 className="text-lg font-bold text-stone-800">回复鉴定意见</h2>
            <p className="text-sm text-stone-500">{answering.question}</p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="鉴定结论与依据（款式判定、版面/内飞核对要点、行情参考、真伪意见…）"
              rows={8}
              maxLength={4000}
              className="w-full rounded-xl border border-stone-200 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-amber-200"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setAnswering(null)}
                className="px-4 py-2 text-sm rounded-lg bg-stone-100 text-stone-600 hover:bg-stone-200"
              >
                取消
              </button>
              <button
                onClick={submitNote}
                disabled={busy || !note.trim()}
                className="px-4 py-2 text-sm rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {busy ? "提交中…" : "提交回复"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
