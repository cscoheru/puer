/**
 * 茶品维度的**热度与排序** —— 纯函数，无 Prisma、无时钟依赖（now 由调用方注入）。
 *
 * ## 为什么不再自己写一套公式
 *
 * 2026-11-02 站长报「经典普洱列表一直都是按品鉴数量倒序，每次点进去都是一样」。
 * 查实两件事叠加：
 *   1. 页面先按 `tastingNoteCount desc` 取**前 120 款**（`forum/classics/page.tsx`），
 *      候选集被品鉴数卡死 —— 品鉴少的茶再热也上不来；
 *   2. `tea-query.ts::heatScore` 里 `tastingNoteCount * 10` 压倒其余项，「新茶加成」
 *      又用 `createdAt`（经典茶都是旧茶 → 恒为 0）。
 *
 * 所以热度**复用热榜那一套公式**（`src/lib/hot-rank.ts::scoreThread`），不另写一份 ——
 * 热榜的公式是「内容质量 × 媒体加成 × 时间加成」，茶品维度把内容质量换成
 * 「该茶下所有帖子与笔记的聚合互动」，其余照搬。AGENTS.md R28：公式只有一份实现。
 *
 * ## 三个排序
 *
 *   heat    —— 热度（默认）。复用 `applyHotRank`，带**读者级 + 每小时轮转**，
 *              所以每次点进来顺序会变（与首页 feed 同一套抖动口径）。
 *   updated —— 最近更新：按该茶的最后活动时间倒序。
 *   notes   —— 品鉴最多：按品鉴笔记数倒序（保留旧口径，作为一个显式选项）。
 *
 * ## 时间口径
 *
 * 「最近更新」用 `lastActivity`，**不是 `createdAt`**：
 *   - 笔记侧取 `max(tastingNote.updatedAt)`（补图/改稿会顶起时间）；
 *   - 帖子侧取 `max(article.lastRepliedAt ?? article.createdAt)`（有新回复就算更新过，
 *     与热榜的 age 口径一致）。
 */
import { applyHotRank, scoreThread, type HotRankInputs } from "./hot-rank.ts";

/** 一款茶参与热度计算所需的聚合输入。 */
export interface TeaHeatInput {
  id: string;
  /** 该茶下所有帖子的净赞（upvotes - downvotes 之和）。 */
  netVotes: number;
  /** 该茶下所有帖子的回复数 + 品鉴笔记的评论数。 */
  replyCount: number;
  /** 去重真实读者数（`article_views` 按茶聚合；爬虫不计）。 */
  realReaders: number;
  /** 有封面 / 图集 / 笔记图。 */
  hasMedia: boolean;
  /** 最后活动时间。 */
  lastActivity: Date;
  /**
   * 站长一手品鉴记录的条数。
   *
   * 为什么要它进热度：**经典普洱里绝大多数茶没有任何跟进帖**，于是互动项全是 0
   * → 分数恒为 0 → 时间加成乘 0 → 热度榜退化成「按品鉴数倒序」，
   * 也就是站长一开始报的那个毛病。加一个**对数**权重的内容项，
   * 这类茶之间才有区分度，且有社区互动的茶仍然排得更高。
   *
   * 用 log1p 而不是线性：线性权重（当年是 `品鉴数×10`）会把这一项变成主导项，
   * 于是热度榜又变回品鉴数倒序。
   */
  tastingNoteCount: number;
}

/** 内容项的权重：够区分「有没有记录」，又不压倒互动项。 */
export const NOTE_COUNT_WEIGHT = 2;

/** 排序口径。 */
export const TEA_SORTS = ["heat", "updated", "notes"] as const;
export type TeaSort = (typeof TEA_SORTS)[number];

/** 归一化排序参数：认得的用它，不认得的（也包括没给）回落到热度。 */
export function normalizeTeaSort(raw: string | null | undefined): TeaSort {
  const v = String(raw ?? "").trim().toLowerCase();
  return (TEA_SORTS as readonly string[]).includes(v) ? (v as TeaSort) : "heat";
}

/** 排序参数的 URL 写法。 */
export function teaSortHref(sort: TeaSort, base: { bar?: string; type?: string; q?: string }): string {
  const params = new URLSearchParams();
  if (base.bar && base.bar !== "all") params.set("bar", base.bar);
  if (base.type) params.set("type", base.type);
  if (base.q) params.set("q", base.q);
  if (sort !== "heat") params.set("sort", sort);
  const qs = params.toString();
  return qs ? `/forum/classics?${qs}` : "/forum/classics";
}

/** 把茶品输入映射成热榜的打分输入（`scoreThread` 的形状）。 */
export function toHotRankInputs(t: TeaHeatInput): HotRankInputs {
  return {
    id: t.id,
    // scoreThread 内部会再取一次 max(0, up - down)，这里先夹一次免得负赞变成 0
    upvotes: Math.max(0, Math.trunc(t.netVotes)),
    downvotes: 0,
    replyCount: Math.max(0, Math.trunc(t.replyCount)),
    realReaders: Math.max(0, Math.trunc(t.realReaders)),
    hasMedia: t.hasMedia,
    createdAt: t.lastActivity,
    lastRepliedAt: t.lastActivity,
  };
}

/** 一款茶的热度分（与论坛热榜**同一个公式**，多带一个内容项）。 */
export function teaHeatScore(t: TeaHeatInput, now: number): number {
  const contentQuality = Math.log1p(Math.max(0, t.tastingNoteCount)) * NOTE_COUNT_WEIGHT;
  return scoreThread(toHotRankInputs(t), now, contentQuality);
}

/**
 * 按热度排序 —— 带读者级 + 每小时轮转的抖动。
 *
 * `bucket` 用小时（与首页 feed 一致）：`Math.floor(now / 3600000)`。
 * 抖动只影响**同一读者**看到的顺序，基础排序对所有读者一致。
 */
export function sortTeasByHeat<T extends TeaHeatInput>(
  teas: T[],
  opts: { now: number; bucket: number; sessionUserId?: string },
): T[] {
  const rows = teas.map((t) => ({ ...t, ...toHotRankInputs(t) }));
  // 排序 + 抖动的流水线复用热榜的 applyHotRank（只换打分函数）
  const ranked = applyHotRank(rows, { ...opts, score: (t) => teaHeatScore(t, opts.now) });
  const order = new Map(ranked.map((r, i) => [r.id, i]));
  // 用 id → 名次 回排原数组：避免把 applyHotRank 的 _hotScore/_finalScore 带出去
  // （那是排序状态，不是页面数据 —— 与 board-threads.ts 的处理一致）。
  return [...teas].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** 按最后活动时间倒序（并列时按名字，保证稳定）。 */
export function sortTeasByUpdated<T extends { lastActivity: Date; name?: string }>(
  teas: T[],
): T[] {
  return [...teas].sort((a, b) => {
    const diff = b.lastActivity.getTime() - a.lastActivity.getTime();
    if (diff !== 0) return diff;
    return (a.name ?? "").localeCompare(b.name ?? "");
  });
}

/** 按品鉴笔记数倒序（并列时按年份、名字，保证稳定）。 */
export function sortTeasByNotes<
  T extends { tastingNoteCount: number; year?: number; name?: string },
>(teas: T[]): T[] {
  return [...teas].sort((a, b) => {
    if (b.tastingNoteCount !== a.tastingNoteCount) {
      return b.tastingNoteCount - a.tastingNoteCount;
    }
    const yearDiff = (b.year ?? 0) - (a.year ?? 0);
    if (yearDiff !== 0) return yearDiff;
    return (a.name ?? "").localeCompare(b.name ?? "");
  });
}

/** 按口径分派（页面只认这一个入口，别在页面里写 if/else）。 */
export function sortTeas<T extends TeaHeatInput & { tastingNoteCount: number; year?: number; name?: string }>(
  teas: T[],
  sort: TeaSort,
  opts: { now: number; bucket: number; sessionUserId?: string },
): T[] {
  if (sort === "updated") return sortTeasByUpdated(teas);
  if (sort === "notes") return sortTeasByNotes(teas);
  return sortTeasByHeat(teas, opts);
}
