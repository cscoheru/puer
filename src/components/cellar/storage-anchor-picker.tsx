"use client";

import { STORAGE_ANCHORS } from "@/lib/cellar";

/**
 * 仓储评分锚点选择器。
 *
 * 两个地方要用它（添加茶、换仓），所以**只有这一份实现** ——
 * 锚点集合在 `src/lib/cellar.ts` 的 `STORAGE_ANCHORS`（PRD §6 的 45/50/55/60
 * 四个锚点 + 中间值）。之前各处各写一遍，其中一处还写死了
 * `[45, 50, 55, 60]` —— 锚点描述是**占位文案**，等站长替换，数组一定会漂。
 */
export default function StorageAnchorPicker({
  value,
  onChange,
  className = "",
}: {
  value: number | null;
  onChange: (score: number | null) => void;
  className?: string;
}) {
  return (
    <div className={`flex gap-2 flex-wrap ${className}`}>
      {STORAGE_ANCHORS.map((a) => (
        <button
          key={a.score}
          onClick={() => onChange(value === a.score ? null : a.score)}
          title={a.desc}
          className={`px-2.5 py-1.5 text-xs rounded-lg border transition ${
            value === a.score
              ? "border-amber-600 bg-amber-50 text-amber-800 font-medium"
              : "border-stone-200 text-stone-600 hover:border-amber-300"
          }`}
        >
          {a.score} {a.label}
        </button>
      ))}
    </div>
  );
}
