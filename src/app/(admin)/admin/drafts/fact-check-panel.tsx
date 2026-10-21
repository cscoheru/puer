"use client";

import { useMemo, useState } from "react";
import {
  extractFactChecks,
  isFactCheckComplete,
  FACT_KIND_LABELS,
  type FactKind,
} from "@/lib/fact-check";

/**
 * F0 事实核对面板（PRD v0.3 §7 F0：「价格、年份、产地、仓储等事实性陈述需
 * 逐项勾选核对」）。
 *
 * 机器挑出正文里的事实句，人逐条打勾。**不是校验器** —— 机器判断不了
 * 「这饼 2017 年的该值多少钱」，它只负责把散落在散文里的事实陈述摆到
 * 审核者面前，避免审核时靠通读全文去抓数字。
 *
 * 勾选状态只存在本地（不入库）：F0 要求的是「审核时逐项核对」这一动作，
 * 而不是一份可被篡改的「已核对」标记。发布动作本身才是留痕（reviewedBy /
 * reviewedAt）。
 */

const KIND_STYLES: Record<FactKind, string> = {
  price: "bg-amber-100 text-amber-800",
  year: "bg-blue-100 text-blue-800",
  origin: "bg-green-100 text-green-800",
  storage: "bg-purple-100 text-purple-800",
  batch: "bg-stone-200 text-stone-700",
};

export default function FactCheckPanel({
  content,
  title,
}: {
  content: string;
  title: string;
}) {
  const items = useMemo(() => extractFactChecks(content), [content]);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  if (items.length === 0) return null;

  const done = isFactCheckComplete(items, checked);

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="border-t border-stone-200 pt-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h4 className="text-sm font-semibold text-stone-700">
            事实核对
            <span className="text-stone-400 font-normal ml-2">
              价格 / 年份 / 产地 / 仓储 / 批次
            </span>
          </h4>
          <p className="text-xs text-stone-400 mt-0.5">
            逐项确认下列陈述与来源一致。机器只负责把它们挑出来，是否属实由你判断。
          </p>
        </div>
        <span
          className={
            "text-xs px-2 py-0.5 rounded-full font-medium " +
            (done ? "bg-green-100 text-green-700" : "bg-stone-100 text-stone-500")
          }
        >
          {checked.size}/{items.length} 已核对
        </span>
      </div>

      <ul className="space-y-1.5">
        {items.map((item) => {
          const on = checked.has(item.id);
          return (
            <li key={item.id}>
              <label
                className={
                  "flex items-start gap-2.5 p-2 rounded border cursor-pointer transition " +
                  (on
                    ? "border-green-200 bg-green-50/50"
                    : "border-stone-200 bg-white hover:border-stone-300")
                }
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(item.id)}
                  className="mt-0.5 accent-green-700 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className={
                        "text-[0.625rem] px-1.5 py-0.5 rounded font-medium " +
                        KIND_STYLES[item.kind]
                      }
                    >
                      {FACT_KIND_LABELS[item.kind]}
                    </span>
                    <span className="text-xs font-mono text-stone-600">{item.matched}</span>
                  </span>
                  <span className="block text-xs text-stone-600 mt-0.5 leading-relaxed">
                    {item.sentence}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      {!done && (
        <p className="text-xs text-stone-400 mt-2">
          提示：{title} 尚有 {items.length - checked.size} 项未核对。
        </p>
      )}
    </div>
  );
}
