/**
 * F1 抽取词表与接地校验（PRD v0.3 §5 Phase 1）。
 *
 * ## 为什么词表要集中在这里
 *
 * stage / delta 是**站长自己的品鉴语汇**，不是通用 NLP 标签。词表写死在
 * 多处会导致：prompt 里一套、评测集里一套、前端展示又一套，最后统计口径
 * 对不上。这里定义唯一真源，prompt、评测脚本、后台复核队列都从这里取。
 *
 * 词表可以改 —— 但改了要重跑评测集（`scripts/f1-eval.mjs`），否则 85%
 * 一致率的结论就失效了。
 *
 * ## 为什么要有接地校验
 *
 * LLM 会把「投茶量没写」补成 7 克、把「没用壶」补成盖碗。PRD 明确要求
 * 「原文未提及的字段保持为空，禁止推测补全」。因此 grams / vessel /
 * descriptors 三个字段在写库前必须逐个验证**确实出现在原文里**；
 * stage / delta 是语义判断，无法词面接地，靠置信度 + 评测一致率兜底。
 *
 * 这个模块不 import 任何运行时依赖 —— 纯函数，可 node:test 直跑。
 */

// ─── Stage ────────────────────────────────────────────────────────────────

/**
 * 普洱茶陈化阶段。
 *
 * 取值用英文是为了跨语言稳定（URL、JSON、统计都安全），中文只做展示。
 * `null` 表示原文没有明确说状态 —— 与「未知」不同，是「不该填」。
 */
export const STAGES = ["ascending", "peak", "drinking", "declining"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  ascending: "上升期",
  peak: "巅峰期",
  drinking: "适饮期",
  declining: "走下坡",
};

/** 模型可能输出的同义词 → 规范取值。用于 normalize，不参与 prompt。 */
const STAGE_SYNONYMS: Record<string, Stage> = {
  上升期: "ascending",
  上升: "ascending",
  转化期: "ascending",
  继续转化: "ascending",
  还在转化: "ascending",
  巅峰期: "peak",
  巅峰: "peak",
  最佳: "peak",
  顶峰: "peak",
  适饮期: "drinking",
  适饮: "drinking",
  稳定期: "drinking",
  稳定: "drinking",
  走下坡: "declining",
  下坡: "declining",
  衰退: "declining",
  开始衰退: "declining",
  走下坡路: "declining",
};

// ─── Delta vs previous tasting ────────────────────────────────────────────

export const DELTAS = ["better", "same", "worse"] as const;
export type Delta = (typeof DELTAS)[number];

export const DELTA_LABELS: Record<Delta, string> = {
  better: "更好",
  same: "差不多",
  worse: "更差",
};

const DELTA_SYNONYMS: Record<string, Delta> = {
  更好: "better",
  变好: "better",
  提升: "better",
  有进步: "better",
  好于上次: "better",
  差不多: "same",
  持平: "same",
  无明显变化: "same",
  没有变化: "same",
  更差: "worse",
  变差: "worse",
  退步: "worse",
  不如上次: "worse",
};

// ─── Vessel ───────────────────────────────────────────────────────────────

/**
 * 器具词表。只收**茶具名词**，不含修饰（「老紫砂壶」归一到「紫砂壶」）。
 * 抽取时模型给什么不重要，最终以「原文里出现了哪个词表项」为准。
 */
export const VESSELS = [
  "盖碗",
  "紫砂壶",
  "紫砂",
  "瓷壶",
  "陶壶",
  "银壶",
  "玻璃杯",
  "飘逸杯",
  "茶壶",
  "煮茶壶",
  "盖杯",
  "马克杯",
] as const;
export type Vessel = (typeof VESSELS)[number];

// ─── 文本归一化 ────────────────────────────────────────────────────────────

/** 全角数字/字母转半角，去掉 HTML 标签，压缩空白。接地校验前统一走这里。 */
export function normalizeForMatch(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.replace(/<[^>]*>/g, " ");
  s = s.replace(/&[a-z#0-9]+;/gi, " ");
  s = s.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  s = s.replace(/[．。]/g, ".");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// ─── 规范化 ────────────────────────────────────────────────────────────────

/** 把模型给的 stage 规整成已知取值；无法识别返回 null（宁空勿猜）。 */
export function normalizeStage(raw: unknown): Stage | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  if ((STAGES as readonly string[]).includes(v)) return v as Stage;
  const lower = v.toLowerCase();
  if ((STAGES as readonly string[]).includes(lower)) return lower as Stage;
  return STAGE_SYNONYMS[v] ?? null;
}

/** 把模型给的 delta 规整成已知取值；无法识别返回 null。 */
export function normalizeDelta(raw: unknown): Delta | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  if ((DELTAS as readonly string[]).includes(v)) return v as Delta;
  const lower = v.toLowerCase();
  if ((DELTAS as readonly string[]).includes(lower)) return lower as Delta;
  return DELTA_SYNONYMS[v] ?? null;
}

// ─── 接地校验（核心防幻觉闸）──────────────────────────────────────────────

/**
 * 投茶量是否真的在原文里。返回原文中出现的那个数值，否则 null。
 *
 * 只认「数字 + 克/g」紧邻的写法，避免把「1987 年」误判成 1987 克。
 */
export function groundGrams(raw: unknown, text: string): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;

  const hay = normalizeForMatch(text);
  // 注意：中文「克」不是 \w 字符，`克\b` 永远匹配不上（JS 的 \b 只认 ASCII 词字符），
  // 所以单位只用 lookahead 排掉紧跟英文字母的情况，不加 \b。
  const re = /(\d+(?:\.\d+)?)\s*(?:克|g(?![a-z])|grams?(?![a-z]))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(hay))) {
    if (Math.abs(Number(m[1]) - n) < 1e-6) return n;
  }
  return null;
}

/**
 * 器具是否真的在原文里。返回命中的词表项（取最长匹配），否则 null。
 *
 * 取最长匹配是为了「紫砂壶」不被截成「紫砂」。
 */
export function groundVessel(raw: unknown, text: string): string | null {
  const hay = normalizeForMatch(text);
  const candidate = typeof raw === "string" ? normalizeForMatch(raw) : "";

  // 原文里出现的器具，按长度降序 —— 保证「紫砂壶」不被截成「紫砂」
  const present = [...VESSELS]
    .filter((v) => hay.includes(v))
    .sort((a, b) => b.length - a.length);
  if (present.length === 0) return null;

  // 模型给的是更宽泛/更具体的写法（紫砂 ↔ 紫砂壶）时，取原文出现的那个完整词；
  // 模型完全说错（原文没这个器具）时，以原文为准 —— 接地校验的意义就在这里。
  if (candidate) {
    const hit = present.find(
      (v) => v.includes(candidate) || candidate.includes(v),
    );
    if (hit) return hit;
  }
  return present[0];
}

/**
 * 描述词是否真的在原文里。逐个校验，只保留原文出现过的。
 *
 * 描述词是主观形容词（「蜜韵」「水路细」），LLM 最容易「补一个合理的」。
 * 所以这里不做同义词映射 —— 原文没写就是没写。
 */
export function groundDescriptors(raw: unknown, text: string): string[] {
  const hay = normalizeForMatch(text);
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[,，、;；\s]+/)
      : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const d = item.trim();
    if (!d || d.length > 20) continue;
    // 描述词会被 Phase 3 的图表/卡片直接渲染。即使目前是纯文本展示，
    // 也不让 HTML 片段进入数据层 —— 存进去容易，事后清理难。
    if (/[<>{}]/.test(d)) continue;
    if (!hay.includes(normalizeForMatch(d))) continue;
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

// ─── 置信度阈值 ────────────────────────────────────────────────────────────

/** 单字段低于这个置信度 → 该字段不写库，进入复核队列。 */
export const FIELD_CONFIDENCE_THRESHOLD = 0.75;

/** 整条笔记低于这个平均置信度 → 整条进复核队列。 */
export const NOTE_CONFIDENCE_THRESHOLD = 0.7;
