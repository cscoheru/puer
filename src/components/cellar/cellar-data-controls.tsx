"use client";

import { useState } from "react";
import { useFeatureFlag } from "@/components/layout/feature-context";

/**
 * 我的数据（导出 / 删除）。
 *
 * PRD §4：「用户数据默认私有；参与匿名汇总需明确同意，**可随时撤回、
 * 导出、删除**」。导出与删除的入口必须握在用户自己手里 —— 写成
 * 「请联系社区管理员」等于没有。
 *
 * 站内**第一个**用户自助导出/删除入口，所以这一段的文案与操作都是
 * 从零写的：删除不可撤销，所以要**打字确认**（不只是点一下），
 * 免得误触把几个月记录清掉。
 */
export default function CellarDataControls() {
  const cellarOn = useFeatureFlag("cellar");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  if (!cellarOn) return null;

  const purge = async () => {
    if (confirmText !== "删除") return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/cellar/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ type: "error", text: data.error || "删除失败" });
        return;
      }
      setMessage({
        type: "success",
        text: `已删除 ${data.items} 个茶仓条目、${data.tastings} 条品鉴记录。`,
      });
      setConfirmText("");
    } catch {
      setMessage({ type: "error", text: "删除失败" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-8">
      <h2 className="text-lg font-bold text-stone-800 mb-1">我的数据</h2>
      <p className="text-xs text-stone-400 mb-4">
        茶仓里的记录默认只有你看得到。可以随时导出或全部删除。
      </p>

      {message && (
        <p
          className={`text-sm mb-3 px-3 py-2 rounded border ${
            message.type === "success"
              ? "bg-green-50 text-green-700 border-green-200"
              : "bg-red-50 text-red-700 border-red-200"
          }`}
        >
          {message.text}
        </p>
      )}

      <div className="space-y-5">
        {/* 导出 */}
        <div>
          <p className="text-sm font-medium text-stone-700 mb-2">导出我的数据</p>
          <p className="text-xs text-stone-400 mb-2">
            包含茶仓条目、仓储记录与全部品鉴记录。
          </p>
          <div className="flex gap-2 flex-wrap">
            <a
              href="/api/cellar/export?format=json"
              className="px-4 py-2 text-sm border border-stone-300 rounded-lg text-stone-700 hover:bg-stone-50 transition min-h-[44px] inline-flex items-center"
            >
              导出 JSON
            </a>
            <a
              href="/api/cellar/export?format=csv"
              className="px-4 py-2 text-sm border border-stone-300 rounded-lg text-stone-700 hover:bg-stone-50 transition min-h-[44px] inline-flex items-center"
            >
              导出 CSV
            </a>
          </div>
        </div>

        <hr className="border-stone-200" />

        {/* 删除 */}
        <div>
          <p className="text-sm font-medium text-stone-700 mb-2">删除我的全部数据</p>
          <p className="text-xs text-stone-400 mb-2">
            清空茶仓里的所有条目、仓储记录与品鉴记录。
            <span className="text-red-600">此操作不可撤销。</span>
            账号本身与你在社区发的帖子不受影响。
          </p>
          <div className="flex gap-2 flex-wrap items-center">
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="输入「删除」以确认"
              className="px-3 py-2 border border-stone-300 rounded-lg text-sm w-44"
            />
            <button
              onClick={purge}
              disabled={busy || confirmText !== "删除"}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition disabled:opacity-40 min-h-[44px]"
            >
              {busy ? "删除中…" : "删除我的全部数据"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
