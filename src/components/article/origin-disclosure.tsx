/**
 * F0 来源标注徽章（PRD v0.3 §7 F0：前台统一标注）。
 *
 * 三层内容在数据与前台都必须可区分：
 *   human          → 不显示任何标注（标注本身是信号，满屏标注等于没标注）
 *   ai_from_notes  → 「站长笔记 · AI 整理」
 *   ai_autonomous  → 「AI 生成 · 非站长品鉴」
 *
 * 组件是纯展示：判定规则在 src/lib/content-origin.ts（服务端与客户端共用）。
 */

import { disclosureLabelFor, parseOrigin } from "@/lib/content-origin";

export default function OriginDisclosure({
  origin,
  className = "",
  translate,
}: {
  origin: string | null | undefined;
  className?: string;
  /** 繁简转换函数（繁體树下需要把标注文案转成繁体）。 */
  translate?: (s: string) => string;
}) {
  const parsed = parseOrigin(origin);
  const raw = disclosureLabelFor(parsed);
  if (!raw) return null;
  const label = translate ? translate(raw) : raw;

  const isAutonomous = parsed === "ai_autonomous";
  return (
    <span
      className={
        "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium " +
        (isAutonomous
          ? "bg-stone-100 text-stone-600"
          : "bg-amber-50 text-amber-700") +
        " " +
        className
      }
      title={
        isAutonomous
          ? "本文由 AI 自行检索与创作，不是站长的品鉴记录"
          : "本文由 AI 依据站长原始品鉴笔记整理，并经人工审核"
      }
    >
      <span aria-hidden="true">{isAutonomous ? "◇" : "✎"}</span>
      {label}
    </span>
  );
}
