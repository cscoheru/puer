/**
 * 复饮提醒（F4 · PRD v0.3 §7）的纯逻辑。
 *
 * ## 这一份文件是「口径」的唯一实现
 *
 * 提醒时间、建议间隔、提醒文案三件事必须**同源** —— 否则会出现
 * 「文案说『建议尽快喝』，建议间隔却还是 6 个月」这种自相矛盾。
 * 所以 `reminderAdvice()` 一次算完三者，其余地方只调用它。
 *
 * ## 提醒时间怎么算
 *
 * ```
 * anchor(item) = 最近一次品鉴的**服务端 createdAt**（按同一条茶跨条目，
 *                 与 24 小时闸门同口径）
 *                 → acquiredAt（夹到 ≤ now）→ createdAt
 *
 * nextRemindAt = max( anchor + N 个月 , lastRemindedAt + N 个月 )
 *                 N = remindEveryMonths（0 = 不提醒 → null）
 * ```
 *
 * `max()` 让两条规则同时成立：
 *   - `anchor + N`   →「记了品鉴就重排提醒」
 *   - `lastRemindedAt + N` →「没喝也每 N 个月再提醒一次」（周期性）
 *
 * 锚点用**服务端 createdAt** 而不是客户端填的 `tastedAt`：tastedAt 是用户
 * 自己给的（同 `cellar.ts` 里 `latestTastingByCreatedAt` 的既有理由）。
 *
 * ## 为什么全程用 UTC
 *
 * `cellar_items.nextRemindAt` 是 `TIMESTAMP(3)`（**无时区**），服务器 TZ 一变
 * 结果就漂；JS 的 `setMonth` 还会踩月末溢出的坑（1 月 31 日 + 1 个月会变成
 * 3 月 3 日）。所以：统一 UTC + 自己夹取到目标月最后一天。
 *
 * 本文件**不依赖 Prisma**，宿主上的跑批脚本可以直接 import（tsx）。
 */
import {
  DEFAULT_REMIND_MONTHS,
  MAX_REMIND_MONTHS,
  suggestRemindMonths,
} from "./cellar.ts";

export { MAX_REMIND_MONTHS };

/** 提醒的三种语气。 */
export type ReminderTone = "better" | "worse" | "neutral";

export interface ReminderAdvice {
  tone: ReminderTone;
  /**
   * 建议的提醒间隔（月）。
   * `null` = 没有建议（提醒已关闭，或还没品鉴过不知道该建议什么）。
   * `tone === "neutral"` 时等于当前间隔（= 不缩短）。
   */
  suggestedMonths: number | null;
  /** 人话（≤ 60 汉字，铃铛里是 line-clamp-2）。 */
  text: string;
}

/**
 * 加 N 个月，**夹到目标月最后一天**。
 *
 * `2026-01-31 + 1 个月 = 2026-02-28`（不是 JS `setMonth` 的 3 月 3 日）。
 * 全程 UTC。
 *
 * @returns null = 月数非法（负数 / 非整数 / 超过上限）
 */
export function addMonths(base: Date, months: number): Date | null {
  if (!Number.isInteger(months)) return null;
  if (months < 0 || months > MAX_REMIND_MONTHS) return null;
  if (months === 0) return new Date(base.getTime());

  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const d = base.getUTCDate();

  // Date.UTC 会自动把月份溢出进位（13 月 → 次年 1 月）
  const target = new Date(Date.UTC(y, m + months, 1));
  // 目标月最后一天
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  target.setUTCHours(
    base.getUTCHours(),
    base.getUTCMinutes(),
    base.getUTCSeconds(),
    base.getUTCMilliseconds(),
  );
  return target;
}

export interface NextRemindInput {
  /** 用户设置的间隔（月）；0 = 不提醒。 */
  remindEveryMonths: number;
  /** 锚点：最近一次品鉴 / 入仓时间 / 创建时间。 */
  anchor: Date | null | undefined;
  /** 上次提醒的时刻（滚动项，参与 max）。 */
  lastRemindedAt?: Date | null;
  /** 「现在」——锚点与上次提醒都会被夹到它，不允许排到未来。 */
  now?: Date;
}

/**
 * 算「下次提醒的时刻」。返回 null = 不提醒（间隔为 0 或数据不合法）。
 */
export function computeNextRemindAt(input: NextRemindInput): Date | null {
  const n = input.remindEveryMonths;
  if (!Number.isInteger(n) || n < 0 || n > MAX_REMIND_MONTHS) return null;
  if (n === 0) return null;

  const now = input.now ?? new Date();
  const nowMs = now.getTime();

  const anchor = input.anchor ? new Date(input.anchor).getTime() : null;
  if (anchor === null || Number.isNaN(anchor)) return null;

  const fromAnchor = addMonths(new Date(Math.min(anchor, nowMs)), n);
  if (!fromAnchor) return null;

  const lastMs = input.lastRemindedAt
    ? new Date(input.lastRemindedAt).getTime()
    : null;
  if (lastMs === null || Number.isNaN(lastMs)) return fromAnchor;

  const fromReminder = addMonths(new Date(Math.min(lastMs, nowMs)), n);
  if (!fromReminder) return fromAnchor;

  return fromReminder.getTime() > fromAnchor.getTime() ? fromReminder : fromAnchor;
}

/** 最近一次品鉴里与提醒有关的两个信号。 */
export interface LastTastingSignal {
  /** 用户自填的对照：better | same | worse。 */
  deltaVsPrev?: string | null;
  /** 阶段：ascending | peak | drinking | declining（declining = 「走下坡」）。 */
  stage?: string | null;
}

/**
 * 算出建议 —— **唯一的建议入口**。
 *
 * ## 信号优先级：阶段 > 对照
 *
 * PRD 写的是「最近一次为『更好』时建议缩短间隔，为『**走下坡**』时建议尽快喝」。
 * 这两把尺子来源不同：
 *   - 「走下坡」= `stage = declining`（站长词表里的阶段，茶本身的客观状态）
 *   - 「更好/更差」= `deltaVsPrev`（**用户自己在快速品鉴里手选的**）
 *
 * 阶段优先 —— 阶段比主观对照更接近「茶现在到底怎么样」。
 *
 * ## 文案不能写成「系统判定」
 *
 * `deltaVsPrev` 是用户自己填的，写成「系统判定你的茶在变好」会让人不舒服
 * （本站是站长手记向的社区，PRD §4 同一条线）。所以是「**你上次选了**」。
 */
export function reminderAdvice(
  last: LastTastingSignal | null | undefined,
  baseMonths: number,
): ReminderAdvice {
  const n = baseMonths;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_REMIND_MONTHS) {
    return {
      tone: "neutral",
      suggestedMonths: null,
      text: "复饮提醒已关闭。",
    };
  }
  if (!last) {
    return {
      tone: "neutral",
      suggestedMonths: null,
      text: "记一条品鉴后，就能给你更准的复饮建议。",
    };
  }

  const declining = last.stage === "declining";
  const delta = last.deltaVsPrev;
  const effective: "better" | "worse" | "same" = declining
    ? "worse"
    : delta === "better"
      ? "better"
      : delta === "worse"
        ? "worse"
        : "same";

  const suggested = suggestRemindMonths(effective, n);
  const shortened = suggested < n;

  if (effective === "better") {
    return {
      tone: "better",
      suggestedMonths: suggested,
      text: shortened
        ? `你上次选了「更好」，建议改成每 ${suggested} 个月提醒一次。`
        : "你上次选了「更好」——这饼正在转好，可以早点开来看变化。",
    };
  }
  if (effective === "worse") {
    return {
      tone: "worse",
      suggestedMonths: suggested,
      text: shortened
        ? `你上次标记为走下坡，建议尽快喝掉；提醒间隔可以调到每 ${suggested} 个月。`
        : "你上次标记为走下坡，建议尽快喝掉。",
    };
  }
  return {
    tone: "neutral",
    suggestedMonths: n,
    text: "",
  };
}

/** 提醒间隔的展示文案。0 = 已关闭。 */
export function remindIntervalLabel(months: number): string {
  if (!Number.isInteger(months) || months <= 0) return "已关闭";
  if (months === 1) return "每 1 个月";
  return `每 ${months} 个月`;
}

/** 铃铛文案的字数上限（铃铛里是 line-clamp-2，太长点不动）。 */
export const REMINDER_TEXT_MAX = 60;

/**
 * 提醒通知的文案。
 *
 * 短、具体、带茶名 —— 用户在铃铛里一眼要认得出是哪饼茶。
 */
export function reminderNotificationText(input: {
  teaName: string | null | undefined;
  months: number;
  advice?: ReminderAdvice | null;
}): string {
  const name = (input.teaName || "你的茶").trim();
  const advice = input.advice ?? null;
  const months = Number.isInteger(input.months) && input.months > 0
    ? input.months
    : DEFAULT_REMIND_MONTHS;

  let text: string;
  if (advice?.tone === "worse") {
    text = `「${name}」上次标为走下坡，建议尽快喝掉。`;
  } else if (advice?.tone === "better") {
    text = `「${name}」上次品鉴选了「更好」，可以早点开来看变化。`;
  } else {
    text = `「${name}」已经 ${months} 个月没复饮了，该开一饼看看变化吗？`;
  }

  if (text.length > REMINDER_TEXT_MAX) {
    // 茶名过长时截短（保留引号与后缀，前缀优先）
    const tail = text.slice(-(REMINDER_TEXT_MAX - 3));
    text = `「${name.slice(0, 8)}…」${tail.slice(tail.indexOf("」") + 1)}`;
    if (text.length > REMINDER_TEXT_MAX) text = text.slice(0, REMINDER_TEXT_MAX);
  }
  return text;
}
