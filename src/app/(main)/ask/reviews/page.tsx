"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useLocale } from "@/i18n/context";

interface Review {
  id: string;
  question: string;
  imageUrls: string[];
  source: string;
  aiVerdict: string | null;
  aiConfidence: number | null;
  aiSkuName: string | null;
  status: string;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

const VERDICT_LABEL: Record<string, string> = {
  same_product: "同款",
  same_series_variant: "同系列不同版",
  different_product: "不同款",
  uncertain: "无法判定",
};

export default function MyReviewsPage() {
  const { data: session, status } = useSession();
  const { _ } = useLocale();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status !== "authenticated") {
      setLoading(false);
      return;
    }
    fetch("/api/review")
      .then((r) => (r.ok ? r.json() : { reviews: [] }))
      .then((d) => setReviews(d.reviews ?? []))
      .finally(() => setLoading(false));
  }, [status]);

  if (status === "unauthenticated") {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center text-stone-500">
        <p>{_("请先登录后查看您的鉴定单")}</p>
        <Link href="/ask" className="inline-block mt-4 text-amber-700 underline underline-offset-2">
          {_("返回茶问")}
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-stone-800">👮 {_("我的鉴定")}</h1>
        <Link href="/ask" className="text-sm text-stone-500 underline underline-offset-2">
          {_("返回茶问")}
        </Link>
      </div>

      {loading ? (
        <div className="text-center text-sm text-stone-400 py-12">
          <div className="inline-block w-6 h-6 border-2 border-amber-300 border-t-amber-600 rounded-full animate-spin mb-3" />
          <p>{_("加载中…")}</p>
        </div>
      ) : reviews.length === 0 ? (
        <div className="rounded-2xl border border-stone-100 bg-white p-10 text-center text-stone-400 text-sm">
          {_("暂无鉴定单。在茶问页上传茶图提问，若 AI 置信不足会自动送人工鉴定，也可手动提交。")}
        </div>
      ) : (
        <div className="space-y-4">
          {reviews.map((r) => (
            <div key={r.id} className="bg-white rounded-2xl border border-stone-100 shadow-sm p-4">
              <div className="flex items-start gap-3">
                {r.imageUrls[0] && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.imageUrls[0]} alt="" className="w-16 h-16 object-cover rounded-lg border border-stone-200" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-stone-800 font-medium truncate">{r.question}</p>
                  <div className="flex items-center gap-2 flex-wrap mt-1.5">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full border ${
                        r.status === "reviewed"
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                          : "bg-amber-50 text-amber-700 border-amber-200"
                      }`}
                    >
                      {r.status === "reviewed" ? _("已回复") : _("待人工鉴定")}
                    </span>
                    {r.aiVerdict && (
                      <span className="text-xs text-stone-400">
                        AI 初判: {VERDICT_LABEL[r.aiVerdict] ?? r.aiVerdict}
                        {r.aiSkuName ? `（${r.aiSkuName}）` : ""}
                        {r.aiConfidence != null ? ` · 置信 ${Math.round(r.aiConfidence * 100)}%` : ""}
                      </span>
                    )}
                    <span className="text-xs text-stone-300">
                      {new Date(r.createdAt).toLocaleString("zh-CN", { hour12: false })}
                    </span>
                  </div>
                </div>
              </div>
              {r.status === "reviewed" && r.reviewNote && (
                <div className="mt-3 rounded-xl bg-emerald-50/70 border border-emerald-100 p-3 text-sm text-stone-700 whitespace-pre-wrap">
                  <p className="text-xs text-emerald-600 font-medium mb-1">{_("人工鉴定意见")}</p>
                  {r.reviewNote}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
