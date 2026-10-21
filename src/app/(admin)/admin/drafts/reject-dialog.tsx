"use client";

import { useState } from "react";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_CATEGORY_LABELS,
  MIN_FEEDBACK_REASON_LENGTH,
} from "@/lib/news-draft/feedback-policy";

/**
 * 草稿「退回」对话框。
 *
 * 退回**必须**给出分类与原因两样东西：
 *  - 分类是**结构化信号**，下游据此改规则（题材过时 → 收紧时效闸；
 *    非知名茶品 → 要求命中库中已知品牌；信息不实 → 收紧数字接地；
 *    内容太泛 → 提高具象信号门槛）；
 *  - 原因文本是**负例**，会进下一轮改写的提示词。
 *
 * 只给「退回」不给原因，等于让反馈烂在锅里——所以原因走必填校验。
 *
 * 分类列表**从共享模块导入**而不是在这里写死：写死会出现「后端加了分类、
 * 前端下拉框没有」的漂移，而下拉框少一项就等于该分类收不到反馈。
 */

const CATEGORY_HINTS: Record<string, string> = {
  stale: "例如 10 月还在写春茶、行情是几个月前的",
  unknown_brand: "涉及的小厂/杂牌茶，站内库中没有",
  inaccurate: "数字、批次、年份或产地对不上原文",
  vague: "只有空话，没有具体价格/产区/批次",
  other: "以上都不是，补充说明",
};

const MIN_REASON = MIN_FEEDBACK_REASON_LENGTH;

export default function RejectDraftDialog({
  draftId,
  draftTitle,
  onDone,
}: {
  draftId: string;
  draftTitle: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<string>("stale");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reasonLen = Array.from(reason.trim()).length;
  const reasonOk = reasonLen >= MIN_REASON;

  async function submit() {
    if (!reasonOk) {
      setError(`请说明退回原因（至少 ${MIN_REASON} 个字）`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/drafts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: draftId, action: "reject", category, reason }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "退回失败");
      // 已退回过的稿子：服务端不重复记录反馈，skipped 标记要如实告诉用户，
      // 否则他会以为自己的原因被记下了。
      if (body?.skipped) {
        alert(body.reason ?? "该稿已退回，未重复记录反馈。");
      }
      setOpen(false);
      setReason("");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "退回失败");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs px-3 py-1.5 rounded-lg border border-stone-300 text-stone-500 hover:text-amber-700 hover:border-amber-300 transition"
      >
        退回
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="退回草稿"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) setOpen(false);
      }}
    >
      <div className="w-full max-w-lg bg-white rounded-xl border border-stone-200 p-5 shadow-xl">
        <h2 className="text-base font-medium text-stone-800">退回草稿</h2>
        <p className="text-xs text-stone-500 mt-1 mb-4 truncate">{draftTitle}</p>

        <fieldset className="space-y-2">
          <legend className="text-xs text-stone-500 mb-1">退回分类（必选）</legend>
          {FEEDBACK_CATEGORIES.map((c) => (
            <label
              key={c}
              className="flex items-start gap-2 text-sm text-stone-700 cursor-pointer"
            >
              <input
                type="radio"
                name="reject-category"
                value={c}
                checked={category === c}
                onChange={() => setCategory(c)}
                className="mt-0.5 accent-amber-700"
              />
              <span>
                {FEEDBACK_CATEGORY_LABELS[c]}
                <span className="block text-xs text-stone-400">{CATEGORY_HINTS[c]}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="block mt-4">
          <span className="text-xs text-stone-500">退回原因（必填）</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="例如：写的是春茶行情，但现在是 10 月，题材已经过时。"
            className="mt-1 w-full text-sm border border-stone-300 rounded-lg p-2 focus:outline-none focus:border-amber-500 resize-y"
          />
          <span className="text-xs text-stone-400">
            {reasonLen} 字{reasonOk ? "" : `（至少 ${MIN_REASON} 字）`}
          </span>
        </label>

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded-lg border border-stone-300 text-stone-600 hover:bg-stone-50 transition disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded-lg bg-amber-700 text-white hover:bg-amber-800 transition disabled:opacity-50"
          >
            {busy ? "退回中..." : "确认退回"}
          </button>
        </div>
      </div>
    </div>
  );
}
