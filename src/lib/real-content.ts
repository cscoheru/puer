import { prisma } from "@/lib/prisma";

/**
 * 展示层的「只计真人」口径（PRD v0.3 §12 决策 4「历史冒用：先锁定池子，
 * 再剔除展示计数」）。
 *
 * ## 为什么需要
 *
 * 站内的展示计数此前把自动化账号的贡献算进去了。近 90 天实测：投票 9,893
 * 里 7,011 来自合成账号（71%），评论 949 里 718 来自合成账号（76%），点赞
 * 895 里 610 来自合成账号（68%）。读者在帖子上看到的「103 赞 · 7 条回复」
 * 可能有三分之二是机器人贡献的。
 *
 * ## 三种计数的分工（别混说）
 *
 *  - 赞 / 踩：冗余列 articles.upvotes / downvotes，由写入路径维护。
 *    机器人脚本用裸 SQL 直接写 votes 表并顺手 UPDATE 计数列，所以列也被污染。
 *    → 由 scripts/recompute-real-counts.mjs 一次性重算，之后只增不减。
 *  - 回复 / 点赞：实时关系计数（_count），没有冗余列。
 *    → 查询时按作者过滤（见本模块）。
 *  - 阅读：articles.viewCount 是 SSR 每渲染一次 +1 的计数器，**没有作者维度**
 *    （爬虫的每次渲染都计入），无法按账号拆分。它的定位是**热度**（热榜
 *    公式的相对值），不是「多少人读过」。前台展示的「阅读」改用
 *    article_views 的去重真实读者数。
 */

/** 真人作者过滤条件（Prisma 关系过滤，to-one 关系的简写形式）。 */
export const REAL_AUTHOR = { isSynthetic: false } as const;

export interface RealArticleCounts {
  /** 真人评论数。 */
  comments: number;
  /** 真人点赞数。 */
  likes: number;
  /** 去重真实读者数（同一读者读多篇只算一个，跨天只算一次）。 */
  readers: number;
}

/**
 * 一篇文章的「只计真人」计数。
 *
 * readers 用 DISTINCT visitorKey —— article_views 的记录粒度是
 * (文章, 访客, 天)，一个读者连读三天会有三条记录，直接 count 会把
 * 「一个人」算成「三天」。
 */
export async function getRealArticleCounts(articleId: string): Promise<RealArticleCounts> {
  const [comments, likes, readerRows] = await Promise.all([
    prisma.comment.count({
      where: { articleId, author: REAL_AUTHOR },
    }),
    prisma.like.count({
      where: { articleId, user: REAL_AUTHOR },
    }),
    prisma.articleView.findMany({
      where: { articleId },
      select: { visitorKey: true },
      distinct: ["visitorKey"],
    }),
  ]);
  return { comments, likes, readers: readerRows.length };
}


/**
 * 批量取去重真实读者数（PRD v0.3 §12 决策 4）。一次查询覆盖整批 id。
 *
 * 热榜排序用它代替 `viewCount` —— 后者是 SSR 渲染计数，爬虫每次渲染都计入。
 * 表刚上线时存量帖子查不到记录 → 0，排序退化为「只看真人互动」。
 *
 * 查询失败时降级为「全部 0」并留日志：统计不可用不该让信息流 500。
 */
export async function loadRealReaders(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  try {
    const rows = await prisma.$queryRaw<Array<{ articleId: string; n: bigint }>>`
      SELECT "articleId", count(DISTINCT "visitorKey")::bigint AS n
      FROM article_views
      -- 必须用 ANY($1::text[])：Prisma 的 $queryRaw 会把 JS 数组参数序列化成
      -- jsonb，写成 IN 加 Prisma.join 的拼接形式会报 operator does not exist: text = jsonb。
      WHERE "articleId" = ANY(${ids}::text[])
      GROUP BY "articleId"
    `;
    return new Map(rows.map((r) => [r.articleId, Number(r.n)]));
  } catch (e) {
    console.error("[real-content] 读取真实读者数失败，按 0 处理", e);
    return new Map();
  }
}
