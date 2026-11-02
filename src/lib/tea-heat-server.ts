/**
 * 茶品热度输入的**数据聚合**（服务端，依赖 Prisma）。
 *
 * 与 `src/lib/tea-heat.ts` 分开：那边是纯函数（可单测、可离线跑），这边碰数据库。
 * 口径只有一份 —— 聚合出来的数字直接喂给 `tea-heat.ts` 的公式。
 *
 * ## 聚的是什么
 *
 * 一款茶的热度来自它下面挂着的**内容**：该茶的跟进帖（Article）与品鉴笔记
 * （TastingNote）。茶品维度没有自己的阅读表（`ArticleView` 只挂 article），
 * 所以真实读者数要把 `article_views` 按 `teaId` join 出来。
 *
 * ## 为什么在 JS 里聚合而不是 groupBy
 *
 * 「最后活动时间」的口径是 `max(lastRepliedAt ?? createdAt)`（有新回复就算更新过）。
 * Prisma 的 `groupBy` 只能分别取 `_max: { lastRepliedAt }` 与 `_max: { createdAt }`，
 * 两者取大会**高估**：一篇文章 lastRepliedAt=5 但 createdAt=100 时，单独取 max(createdAt)
 * 会把 100 当成它的活动时间。经典茶只有一百多款，帖子数量级几百 —— 直接取出来在
 * JS 里算更准，也更少踩 Prisma 聚合表达式的限制。
 */
import { prisma } from "@/lib/prisma";
import { sortTeas, type TeaHeatInput, type TeaSort } from "./tea-heat.ts";

/** 参与聚合的茶品最小信息（封面/图集决定「有没有媒体」）。 */
export interface TeaMediaRef {
  id: string;
  coverImage: string | null;
  gallery: unknown;
}

/**
 * 按茶品聚合真实读者数（去重 visitorKey，爬虫不计）。
 *
 * ⚠️ 绑定数组参数必须写 `ANY($1::text[])`：Prisma 的 `$queryRaw` 会把 JS 数组
 * 序列化成 jsonb，写成 `IN (...)` 会报 `operator does not exist: text = jsonb`
 * （`src/lib/real-content.ts::loadRealReaders` 里踩过一次，见 `puer-prisma-array-param-jsonb`）。
 */
async function loadTeaRealReaders(teaIds: string[]): Promise<Map<string, number>> {
  if (teaIds.length === 0) return new Map();
  try {
    const rows = await prisma.$queryRaw<Array<{ teaId: string; n: bigint }>>`
      SELECT a."teaId", count(DISTINCT v."visitorKey")::bigint AS n
      FROM article_views v
      JOIN articles a ON a.id = v."articleId"
      WHERE a."teaId" = ANY(${teaIds}::text[])
        AND a."status" = 'published'
      GROUP BY a."teaId"
    `;
    return new Map(rows.map((r) => [r.teaId, Number(r.n)]));
  } catch (e) {
    // 统计不可用不该让列表 500 —— 降级成「读者数按 0」，排序退化为只看互动
    console.error("[tea-heat] 读取茶品真实读者数失败，按 0 处理", e);
    return new Map();
  }
}

function hasImages(value: unknown): boolean {
  return Array.isArray(value) && value.some((x) => typeof x === "string" && x.length > 0);
}

/**
 * 每款茶的**最后活动时间** —— 一份口径，两处用（经典页的「最近更新」tab 与
 * 侧栏「热点经典茶品」）。
 *
 * 口径：
 *   - 笔记侧：`max(tasting_notes."updatedAt")`（补图/改稿会顶起时间，
 *     `createdAt` 不会）；
 *   - 帖子侧：`max(COALESCE(articles."lastRepliedAt", articles."createdAt"))`
 *     （有新回复就算「更新过」，与论坛热榜的 age 口径一致）。
 *
 * 写成一条 SQL 是因为 Prisma 的 `groupBy` 表达不了 `COALESCE` —— 而
 * `max(max(lastRepliedAt), max(createdAt))` 会**高估**：一篇
 * lastRepliedAt=5 但 createdAt=100 的文章，会被当成 100 那天活跃过。
 *
 * ⚠️ 绑定数组参数必须写 `ANY($1::text[])`：Prisma 的 `$queryRaw` 会把 JS
 * 数组序列化成 jsonb（见 `puer-prisma-array-param-jsonb`）。
 */
export async function loadTeaLastActivity(
  teaIds: string[],
): Promise<Map<string, Date>> {
  if (teaIds.length === 0) return new Map();
  try {
    const rows = await prisma.$queryRaw<Array<{ teaId: string; lastActivity: Date }>>`
      SELECT "teaId", max("activity") AS "lastActivity"
      FROM (
        SELECT "teaId", "updatedAt" AS "activity"
          FROM tasting_notes
         WHERE "teaId" = ANY(${teaIds}::text[])
        UNION ALL
        SELECT a."teaId", COALESCE(a."lastRepliedAt", a."createdAt") AS "activity"
          FROM articles a
         WHERE a."teaId" = ANY(${teaIds}::text[])
           AND a."status" = 'published'
      ) t
      GROUP BY "teaId"
    `;
    return new Map(rows.map((r) => [r.teaId, r.lastActivity]));
  } catch (e) {
    console.error("[tea-heat] 读取茶品最后活动时间失败，按无活动处理", e);
    return new Map();
  }
}

/**
 * 聚合每款茶的热度输入。
 *
 * @param teas 参与排序的茶品（至少要有 id；封面/图集用于判定「有没有媒体」）
 */
export async function loadTeaHeatInputs(
  teas: TeaMediaRef[],
): Promise<Map<string, TeaHeatInput>> {
  const out = new Map<string, TeaHeatInput>();
  const teaIds = teas.map((t) => t.id);
  if (teaIds.length === 0) return out;

  for (const t of teas) {
    out.set(t.id, {
      id: t.id,
      netVotes: 0,
      replyCount: 0,
      realReaders: 0,
      hasMedia: !!t.coverImage || hasImages(t.gallery),
      // 没有活动时用纪元前 —— 排序时垫底（时间加成最小）
      lastActivity: new Date(0),
    });
  }

  const [articles, notes, readers, activities] = await Promise.all([
    prisma.article
      .findMany({
        where: { teaId: { in: teaIds }, status: "published" },
        select: {
          teaId: true,
          upvotes: true,
          downvotes: true,
          replyCount: true,
          videoUrl: true,
          images: true,
        },
      })
      .catch(() => []),
    prisma.tastingNote
      .findMany({
        where: { teaId: { in: teaIds } },
        select: {
          teaId: true,
          updatedAt: true,
          images: true,
          _count: { select: { comments: true } },
        },
      })
      .catch(() => []),
    loadTeaRealReaders(teaIds),
    loadTeaLastActivity(teaIds),
  ]);

  for (const a of articles) {
    if (!a.teaId) continue;
    const row = out.get(a.teaId);
    if (!row) continue;
    row.netVotes += a.upvotes - a.downvotes;
    row.replyCount += a.replyCount;
    if (a.videoUrl || a.images.length > 0) row.hasMedia = true;
  }

  for (const n of notes) {
    const row = out.get(n.teaId);
    if (!row) continue;
    row.replyCount += n._count.comments;
    if (hasImages(n.images)) row.hasMedia = true;
  }

  // 最后活动时间：**同一份口径**（与侧栏的「热点经典茶品」共用
  // loadTeaLastActivity），不要在这里另算一遍。
  for (const [teaId, at] of activities) {
    const row = out.get(teaId);
    if (row) row.lastActivity = at;
  }

  for (const [teaId, n] of readers) {
    const row = out.get(teaId);
    if (row) row.realReaders = n;
  }

  return out;
}

/**
 * 页面用的排序入口：**聚合一 + 排序**一步到位。
 *
 * 为什么把 `Date.now()` 藏在这里：React 的纯度规则不允许在组件渲染体里调用
 *  impure 函数（`react-hooks/purity` 会拦 `Date.now()`）。这个模块是普通模块，
 * 不是组件 —— 调用点就干净了，页面上只剩一行 `await rankTeasForPage(...)`。
 *
 * @param teas          参与排序的茶品行
 * @param sort          排序口径（热度 / 最近更新 / 品鉴最多）
 * @param sessionUserId 当前用户（用于读者级抖动；匿名传 undefined）
 */
export async function rankTeasForPage<
  T extends { id: string; tastingNoteCount: number; year?: number; name?: string },
>(teas: T[], sort: TeaSort, sessionUserId?: string): Promise<(T & TeaHeatInput)[]> {
  if (teas.length === 0) return [];
  const heatMap = await loadTeaHeatInputs(
    teas.map((t) => ({
      id: t.id,
      coverImage: (t as { coverImage?: string | null }).coverImage ?? null,
      gallery: (t as { gallery?: unknown }).gallery ?? null,
    })),
  );
  const now = Date.now();
  return sortTeas(
    teas.map((t) => ({
      ...t,
      ...(heatMap.get(t.id) ?? {
        id: t.id,
        netVotes: 0,
        replyCount: 0,
        realReaders: 0,
        hasMedia: false,
        lastActivity: new Date(0),
      }),
    })),
    sort,
    // 每小时轮转（与首页 feed 同一套抖动口径）
    { now, bucket: Math.floor(now / 3600000), sessionUserId },
  );
}
