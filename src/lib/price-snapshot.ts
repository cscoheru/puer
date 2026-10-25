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
