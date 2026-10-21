/**
 * 列表翻页深度上限（PRD v0.3 §8「抓取：…列表翻页深度设上限」）。
 *
 * 现状的漏洞：`/api/articles?limit=10000` 一次拉走全部帖子，
 * `?page=99999` 也能把 skip 顶到天上。两者叠加 = 爬虫三四个请求就能把
 * 全站内容搬走，而且每个请求都是一次真实的数据库查询。
 *
 * 两条设计原则：
 *  1. **管理员不受限**。管理后台要 `?limit=9999` 一次拉全量茶品
 *     （/admin/teas、/admin/brands 等页面都这么用），一刀切会把后台打坏。
 *  2. **超限不是报错，是收敛**。公开 URL 应当降级而不是失败 ——
 *     与 `pagination.ts` 里 parsePage 的既有约定一致。
 *
 * 纯函数、零依赖，可单测。
 */

/** 单页最多返回多少条（公开访问）。 */
export const MAX_PUBLIC_LIMIT = 60;

/**
 * 公开访问最多翻到第几页。
 * 60 × 50 = 3000 条，已覆盖当前全部内容量（帖子 537、茶品 1729）。
 * 再往深翻没有新内容，只是白花数据库。
 */
export const MAX_PUBLIC_PAGE = 50;

/** 信息流最多滚到第几条（offset 语义）。 */
export const MAX_PUBLIC_OFFSET = 300;

/** 解析并夹取 limit。管理员原样放行。 */
export function clampListLimit(
  raw: string | number | null | undefined,
  opts: { isAdmin: boolean; fallback?: number; max?: number },
): number {
  const fallback = opts.fallback ?? 20;
  const max = opts.max ?? MAX_PUBLIC_LIMIT;
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  if (opts.isAdmin) return n;
  return Math.min(n, max);
}

/** 解析并夹取页码。管理员原样放行（但仍挡 NaN/负数）。 */
export function clampListPage(
  raw: string | number | null | undefined,
  opts: { isAdmin: boolean; fallback?: number; max?: number },
): number {
  const fallback = opts.fallback ?? 1;
  const max = opts.max ?? MAX_PUBLIC_PAGE;
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  if (opts.isAdmin) return n;
  return Math.min(n, max);
}

/** 解析并夹取 offset。 */
export function clampOffset(
  raw: string | number | null | undefined,
  opts: { isAdmin?: boolean; fallback?: number; max?: number } = {},
): number {
  const fallback = opts.fallback ?? 0;
  const max = opts.max ?? MAX_PUBLIC_OFFSET;
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  if (!Number.isSafeInteger(n) || n < 0) return fallback;
  if (opts.isAdmin) return n;
  return Math.min(n, max);
}

/**
 * 越界时是否「还有更多」。
 *
 * 翻页被收敛后，客户端会以为到底了（拿不到第 51 页）。这里把真实总数
 * 一并返回，让前端能显示「已到上限」而不是假装没有更多。
 */
export function paginationCapped(
  requestedPage: number,
  effectivePage: number,
): boolean {
  return requestedPage > effectivePage;
}
