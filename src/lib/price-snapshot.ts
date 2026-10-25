/**
 * 行情快照（F5 · PRD v0.3 §7 Phase 4）的纯逻辑。
 *
 * ## 这一份文件是「口径」的唯一实现
 *
 * 价格区间的展示、涨跌、与站长线的对照都在这里算 —— 前台（茶品页）与后台
 * （录入页）用同一份，两边不会各说各话。
 *
 * ## 不 import Prisma
 *
 * 这个文件要被裸 `node --test` 跑（路径别名 `@/` 在那里解析不了），
 * 所以数据库那一层在 `src/lib/price-snapshot-data.ts`。
 */
import { STAGE_LABELS, type Stage } from "./tasting-extract/vocab.ts";

/** 一条价格快照（DB 行的形状）。 */
export interface PriceSnapshotRow {
  id: string;
  teaId: string;
  /** 快照日期（ISO）。 */
  snapshotDate: string;
  /** 区间下限（元）。 */
  low: number;
  /** 区间上限（元）。 */
  high: number;
  currency: string;
  /** 来源 —— 必填（站长自己说清楚这条价从哪来）。 */
  sourceLabel: string;
  note: string | null;
}

/** 站长线上的一个点（用于对照「当时这饼茶处于什么阶段」）。 */
export interface EditorStagePoint {
  /** 服务端写入时刻（ISO）。 */
  createdAt: string;
  stage: string | null;
}

/** 常见币种符号。 */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: "¥",
  USD: "$",
  HKD: "HK$",
  EUR: "€",
};

/** 千分位 —— 不用 toLocaleString：服务端与浏览器的 ICU 结果可能不一样。 */
export function withCommas(n: number): string {
  const sign = n < 0 ? "-" : "";
  return sign + String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 「¥3,800 – ¥4,500」。上下限相同时只显示一个数。 */
export function formatPriceRange(
  low: number,
  high: number,
  currency = "CNY",
): string {
  const sym = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  if (low === high) return `${sym}${withCommas(low)}`;
  return `${sym}${withCommas(low)} – ${sym}${withCommas(high)}`;
}

/** 一个快照的「中位价」—— 用来算涨跌。 */
export function midpoint(s: { low: number; high: number }): number {
  return (s.low + s.high) / 2;
}

/** 距上一次快照多少天（PRD：按季度，约 90 天）。 */
export const PRICE_SNAPSHOT_INTERVAL_DAYS = 90;

export interface QuarterHint {
  /** 距上次快照多少天；null = 从来没录过。 */
  daysSinceLast: number | null;
  /** 不到一个季度就又要录了 —— 提醒一句，但不拦。 */
  tooSoon: boolean;
  /** 人话。 */
  text: string;
}

/**
 * 「按季度录」的提醒。
 *
 * 季度是**约定**不是约束 —— 站长有理由补录时应该能录，所以这里只提示，
 * 不拦（拦截的事交给 DB 的 UNIQUE：同茶同日不重复）。
 */
export function quarterHint(
  lastSnapshotDate: string | null,
  now: Date = new Date(),
): QuarterHint {
  if (!lastSnapshotDate) {
    return {
      daysSinceLast: null,
      tooSoon: false,
      text: "这款茶还没有录过行情",
    };
  }
  const last = new Date(lastSnapshotDate);
  if (Number.isNaN(last.getTime())) {
    return { daysSinceLast: null, tooSoon: false, text: "" };
  }
  const days = Math.floor((now.getTime() - last.getTime()) / 86400000);
  return {
    daysSinceLast: days,
    tooSoon: days < PRICE_SNAPSHOT_INTERVAL_DAYS,
    text:
      days < PRICE_SNAPSHOT_INTERVAL_DAYS
        ? `距上次只过了 ${days} 天（按季度建议约 ${PRICE_SNAPSHOT_INTERVAL_DAYS} 天）`
        : `距上次 ${days} 天`,
  };
}

/** 茶品页上的一条行情（快照 + 对照）。 */
export interface PriceTimelineEntry {
  snapshot: PriceSnapshotRow;
  /** 价格区间的展示串。 */
  range: string;
  /** 与上一条快照相比的涨跌幅（%）；null = 没有上一条。 */
  changePct: number | null;
  /** 快照当时站长线的阶段（原始值）。 */
  stageAtThatTime: string | null;
  /** 快照当时站长线的阶段标签。 */
  stageLabel: string | null;
}

/**
 * 把价格快照与站长线**对齐** —— PRD F5：「价格区间时间线与站长线叠加，
 * 可对照『价格涨跌』与『转化状态』」。
 *
 * 对齐方式：每条快照取**它之前最近的一条**站长线记录 —— 那就是「录这条价
 * 的时候，这饼茶处于什么阶段」。
 */
export function priceTimelineWithStages(
  snapshots: PriceSnapshotRow[],
  editorPoints: EditorStagePoint[],
): PriceTimelineEntry[] {
  const points = [...editorPoints].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const ordered = [...snapshots].sort((a, b) =>
    a.snapshotDate.localeCompare(b.snapshotDate),
  );

  const out: PriceTimelineEntry[] = [];
  let prevMid: number | null = null;

  for (const snapshot of ordered) {
    const day = snapshot.snapshotDate.slice(0, 10);
    let stage: string | null = null;
    for (const p of points) {
      if (p.createdAt.slice(0, 10) <= day) stage = p.stage;
      else break;
    }

    const mid = midpoint(snapshot);
    let changePct: number | null = null;
    if (prevMid !== null && prevMid > 0) {
      changePct = Math.round(((mid - prevMid) / prevMid) * 1000) / 10;
    }

    out.push({
      snapshot,
      range: formatPriceRange(snapshot.low, snapshot.high, snapshot.currency),
      changePct,
      stageAtThatTime: stage,
      stageLabel: stage && stage in STAGE_LABELS
        ? STAGE_LABELS[stage as Stage]
        : null,
    });
    prevMid = mid;
  }

  return out;
}

/** 「行情仅供参考，不构成投资建议」—— 全站统一的一句。 */
export const PRICE_DISCLAIMER = "行情仅供参考，不构成投资建议。";

// ─── 按东和行情给一个价格区间的建议 ─────────────────────────────────────

/**
 * 库里的 `marketInfo.price` 是**给人看的展示串**，不是数字：
 *
 *   "5.6万/件"                     → 56000
 *   "3.6万～6.8万/件（结合品相和仓储）" → 36000～68000
 *   "0.16元/克"                    → 每克价，**不能**当每件价用
 *
 * 所以要解析回数字才能拿来当区间上下限。
 */
export interface MarketPriceParse {
  /** 解析出的每件价（元）。null = 解析不出，或不是每件价。 */
  value: number | null;
  kind: "piece" | "range" | "perGram" | "unknown";
  /** 原样展示串。 */
  raw: string;
}

/** 解析 `marketInfo.price` 展示串 → 每件价（元）。 */
export function parseMarketPrice(
  raw: string | null | undefined,
): MarketPriceParse {
  const s = (raw ?? "").trim();
  if (!s) return { value: null, kind: "unknown", raw: s };
  // 每克价不是每件价（拿它当上下限会离谱地低）
  if (/元\/克|每克/.test(s)) {
    return { value: null, kind: "perGram", raw: s };
  }
  // 去掉括号里的补充说明：「…/件（结合品相和仓储）」
  const body = s.replace(/[（(][^）)]*[)）]/g, "").trim();

  const nums: number[] = [];
  const re = /(\d+(?:\.\d+)?)\s*(万|千)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    let v = Number(m[1]);
    if (m[2] === "万") v *= 10000;
    else if (m[2] === "千") v *= 1000;
    if (Number.isFinite(v) && v > 0) nums.push(v);
  }
  if (nums.length === 0) return { value: null, kind: "unknown", raw: s };
  // 是一个区间就取**上限**（站长 2026-10-25：「上限请参考东和行情」）
  return {
    value: Math.max(...nums),
    kind: nums.length > 1 ? "range" : "piece",
    raw: s,
  };
}

/** 下限相对上限的比例（站长定的 60%）。 */
export const MARKET_RANGE_LOW_RATIO = 0.6;

/**
 * 按东和行情给一个价格**区间**建议。
 *
 * 站长 2026-10-25：「上限请参考东和行情，下限为东和行情的 60%」。
 *
 * @returns null = 这款茶没有可用的东和行情（或只有每克价）→ 不给建议
 */
export function suggestRangeFromMarketPrice(
  raw: string | null | undefined,
  lowRatio: number = MARKET_RANGE_LOW_RATIO,
): { low: number; high: number } | null {
  const parsed = parseMarketPrice(raw);
  if (parsed.value === null) return null;
  const high = Math.round(parsed.value);
  // 下限取整到 10 —— 「3880 元」比「3883.2 元」像人话
  const low = Math.round((high * lowRatio) / 10) * 10;
  return { low: Math.min(low, high), high };
}
