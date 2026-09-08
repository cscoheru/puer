"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";

interface ReportButtonProps {
  targetType: "article" | "comment" | "user" | "session";
  targetId: string;
}

const REPORT_REASONS = [
  "涉及政治敏感内容",
  "色情或赌博内容",
  "投资理财推销",
  "与茶/茶器无关",
  "虚假信息或广告",
  "人身攻击或辱骂",
  "其他",
];

export default function ReportButton({ targetType, targetId }: ReportButtonProps) {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  if (!session?.user) return null;

  async function handleSubmit() {
    const finalReason = reason === "其他" ? customReason : reason;
    if (!finalReason?.trim()) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType, targetId, reason: finalReason.trim() }),
      });
      if (res.ok) {
        setDone(true);
        setTimeout(() => setOpen(false), 1500);
      } else {
        const data = await res.json();
        alert(data.error || "举报失败");
      }
    } catch {
      alert("网络错误");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        onClick={() => { setOpen(true); setDone(false); }}
        className="inline-flex items-center gap-1.5 text-xs text-stone-400 hover:text-amber-600 transition"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
          <path fillRule="evenodd" d="M2.5 3A1.5 1.5 0 001 4.5v4A1.5 1.5 0 002.5 10h6A1.5 1.5 0 0010 8.5v-4A1.5 1.5 0 008.5 3h-6zm11 0A1.5 1.5 0 0012 4.5v4a1.5 1.5 0 001.5 1.5h3A1.5 1.5 0 0018 8.5v-4A1.5 1.5 0 0016.5 3h-3zM4.5 11A1.5 1.5 0 003 12.5v3A1.5 1.5 0 004.5 17h3A1.5 1.5 0 009 15.5v-3A1.5 1.5 0 007.5 11h-3z" clipRule="evenodd" />
        </svg>
        举报
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-sm w-full mx-4 p-5" onClick={(e) => e.stopPropagation()}>
            {done ? (
              <div className="text-center py-4">
                <p className="text-lg mb-1">✅</p>
                <p className="text-sm text-stone-600">举报已提交，管理员会尽快处理</p>
              </div>
            ) : (
              <>
                <h3 className="text-sm font-semibold text-stone-800 mb-3">举报内容</h3>
                <div className="space-y-1.5 mb-4">
                  {REPORT_REASONS.map((r) => (
                    <label key={r} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="radio"
                        name="report-reason"
                        value={r}
                        checked={reason === r}
                        onChange={() => setReason(r)}
                        className="accent-amber-600"
                      />
                      <span className={reason === r ? "text-stone-800" : "text-stone-500"}>{r}</span>
                    </label>
                  ))}
                </div>
                {reason === "其他" && (
                  <textarea
                    value={customReason}
                    onChange={(e) => setCustomReason(e.target.value)}
                    placeholder="请说明举报原因..."
                    className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm mb-3 resize-none h-20 focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                  />
                )}
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setOpen(false)}
                    className="px-3 py-1.5 text-sm text-stone-500 hover:text-stone-700 transition"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleSubmit}
                    disabled={!reason || submitting || (reason === "其他" && !customReason.trim())}
                    className="px-4 py-1.5 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {submitting ? "提交中..." : "提交举报"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
