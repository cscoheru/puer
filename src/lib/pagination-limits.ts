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

/**
 * 解析用户请求的页码。
 *
 * 四个列表路由各抄一份 `parseInt(searchParams.get("page") || "1", 10)` ——
 * 而 348b6f6 就是在这种抄写里把声明删了却留着用法，整个列表接口 500。
 * 收成一处，顺带把非法输入归一到 1：**永不吐 NaN** ——
 * `paginationCapped(NaN, page)` 恒为 false，语义含混。
 */
export function parseRequestedPage(raw: string | null | undefined): number {
  const n = parseInt(String(raw ?? "1"), 10);
  return Number.isSafeInteger(n) && n >= 1 ? n : 1;
}

/** 总页数 —— 服务端的响应与客户端的视图用同一个公式，别各写一份。 */
export function listTotalPages(total: number, limit: number): number {
  const t = Number.isFinite(total) ? Math.max(0, total) : 0;
  const l = Number.isFinite(limit) ? Math.max(1, limit) : 1;
  return Math.max(1, Math.ceil(t / l));
}

/**
 * 列表页的分页视图 —— 客户端按这个渲染，不自己算。
 *
 * 两个口径在这里合流：
 *  - `pages` 是**真能翻到的**页数。服务端给的页数（total / limit）不受
 *    翻页深度上限约束，不夹一下的话，用户在第 50 页点「下一页」会原地
 *    打转 —— 服务端把 51 收敛回 50，还是给第 50 页的数据。
 *  - `page` 是服务端**实际**返回的页码（请求页可能被收敛过）。
 *    这里不把它夹到 `pages` 上：宁可显示「第 50 / 3 页」这种一眼看出
 *    不对的，也不显示「第 3 / 3 页」配一个空列表 —— 后者会让人以为
 *    自己的茶不见了。
 *
 * `truncated` = 「还有记录翻不到」（总数推出的页数比能翻到的多）。
 * 这跟服务端的 `capped` **不是一回事**：
 * `capped` 说的是「你**这次**请求被收敛了」（requestedPage > page），
 * 而客户端把 pages 夹住之后就再也不会请求超出上限的页，那个标志于是
 * 恒为 false —— 拿它当截断提示的开关就是死代码。
 *
 * 入参只要 total 与 limit 就够：站内的列表接口（/api/articles、/api/teas、
 * /api/tea-inventory、/api/cellar）都返回这两个字段，口径统一。
 */
export function listPaginationView(
  input: { total: number; limit: number; effectivePage: number },
  opts: { isAdmin: boolean },
): { page: number; pages: number; truncated: boolean } {
  const totalPages = listTotalPages(input.total, input.limit);
  const pages = opts.isAdmin
    ? totalPages
    : Math.min(totalPages, MAX_PUBLIC_PAGE);
  const effectivePage = Number.isFinite(input.effectivePage)
    ? Math.max(1, input.effectivePage)
    : 1;
  return { page: effectivePage, pages, truncated: totalPages > pages };
}
