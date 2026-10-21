/**
 * F0 来源标注徽章（PRD v0.3 §7 F0：前台统一标注）。
 *
 * 三层内容在数据与前台都必须可区分：
 *   human          → 不显示任何标注（标注本身是信号，满屏标注等于没标注）
 *   ai_from_notes  → 「站长笔记 · AI 整理」
 *   ai_autonomous  → 「AI 生成 · 非站长品鉴」+ 来源链接
 *
 * 组件是纯展示：判定规则在 src/lib/content-origin.ts（服务端与客户端共用）。
 *
 * 来源链接（F0「并附信息来源链接」）：只渲染 http/https 开头且长度合理的
 * URL —— 数据库里的这一列由写入管线填，但「渲染前不校验」等于把
 * javascript: 伪协议放进 href。
 */

import { disclosureLabelFor, parseOrigin } from "@/lib/content-origin";

/** 只接受 http/https 链接，且长度上限防畸形串。 */
function safeSourceUrl(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const u = raw.trim();
  if (!u || u.length > 2048) return null;
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

export default function OriginDisclosure({
  origin,
  sourceUrls,
  className = "",
  translate,
}: {
  origin: string | null | undefined;
  sourceUrls?: readonly string[] | null;
  className?: string;
  /** 繁简转换函数（繁體树下需要把标注文案转成繁体）。 */
  translate?: (s: string) => string;
}) {
  const parsed = parseOrigin(origin);
  const raw = disclosureLabelFor(parsed);
  if (!raw) return null;
  const label = translate ? translate(raw) : raw;

  const isAutonomous = parsed === "ai_autonomous";
  const links = (sourceUrls ?? [])
    .map(safeSourceUrl)
    .filter((u): u is string => u !== null);

  return (
    <span className={"inline-flex flex-wrap items-center gap-1.5 " + className}>
      <span
        className={
          "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium " +
          (isAutonomous
            ? "bg-stone-100 text-stone-600"
            : "bg-amber-50 text-amber-700")
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
      {links.map((u) => (
        <a
          key={u}
          href={u}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs bg-stone-100 text-stone-500 hover:text-amber-700 hover:bg-stone-200 transition"
          title="查看信息来源原文"
        >
          <span aria-hidden="true">↗</span>
          {translate ? translate("来源") : "来源"}
        </a>
      ))}
    </span>
  );
}
