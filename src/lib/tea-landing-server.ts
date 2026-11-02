import { prisma } from "@/lib/prisma";
import {
  LANDING_MIN_TEAS,
  YEAR_RANGE,
  normalizeTeaType,
  teaListSelect,
  type TeaListRow,
} from "@/lib/tea-query";
import { sortTeas, type TeaHeatInput } from "@/lib/tea-heat.ts";
import { loadTeaHeatInputs } from "@/lib/tea-heat-server.ts";
import { visibleTeaWhere } from "@/lib/tea-tier.ts";

/**
 * 「经典」= 站长认可的茶品集合。
 *
 * `visibleTeaWhere()`（needsReview:false）是「还没被站长整理过」的排除口径 ——
 * 2026-11-02 收口：经典区的读点此前**不**带它，用户自建的茶（越权口子放进去的）
 * 会直接公开出现在经典普洱区、侧栏、sitemap 与落地页里。
 */
const CLASSIC = { isClassic: true, deletedAt: null, ...visibleTeaWhere() } as const;

export type Facets = {
  brands: { brand: string; count: number; latest: Date | null }[];
  types: { key: "raw" | "ripe"; count: number; latest: Date | null }[];
  years: { year: number; count: number; latest: Date | null }[];
};

/**
 * 品牌/生熟/年份聚合页的**唯一准入判据**。
 *
 * sitemap、/tea 的分类导航、落地页的 notFound 闸门、茶详情页的面包屑——全都从这里取，
 * 不要再各自实现一遍。曾经在 `tea/[id]` 里本地算 `brandTeaCount >= LANDING_MIN_TEAS`，
 * 就是因为漏了这里的「未知」排除，导致 28 个公开茶页挂出 404 面包屑。
 *
 * `latest` 是该类目下最新一款茶的 `updatedAt`，供 sitemap 的 lastModified 使用
 * （该 sitemap 是 force-dynamic，用 `new Date()` 会被 Google 判定为无信息量）。
 * 类型上是 `Date | null`，但组内至少一行，运行时不会为 null。
 *
 * 故意不 `catch(() => [])`：本函数被 `force-dynamic` 的落地页调用，不在 build 期执行；
 * 若 DB 抖动被吞成空分布，页面会因 `self` 缺失而 notFound → **404**，
 * 等于告诉 Google 这些 URL 已消失（会被移出索引）。让它抛出去返回 5xx 才是对的
 * —— 5xx 被搜索引擎视作暂时故障，URL 保留。
 */
export async function loadFacets(): Promise<Facets> {
  const [brandGroups, yearGroups, typeRows] = await Promise.all([
    prisma.tea.groupBy({
      by: ["brand"],
      where: CLASSIC,
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
    prisma.tea.groupBy({
      by: ["year"],
      where: CLASSIC,
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
    prisma.tea.findMany({ where: CLASSIC, select: { type: true, updatedAt: true } }),
  ]);

  const enough = (n: number) => n >= LANDING_MIN_TEAS;

  const typeStat = new Map<"raw" | "ripe", { count: number; latest: Date }>();
  for (const t of typeRows) {
    const k = normalizeTeaType(t.type);
    if (!k) continue;
    const prev = typeStat.get(k);
    typeStat.set(k, {
      count: (prev?.count ?? 0) + 1,
      latest: !prev || t.updatedAt > prev.latest ? t.updatedAt : prev.latest,
    });
  }

  return {
    brands: brandGroups
      .filter((g) => enough(g._count._all) && g.brand && g.brand !== "未知")
      .map((g) => ({ brand: g.brand, count: g._count._all, latest: g._max.updatedAt }))
      .sort((a, b) => b.count - a.count),
    types: (["raw", "ripe"] as const)
      .map((key) => {
        const s = typeStat.get(key);
        return { key, count: s?.count ?? 0, latest: s?.latest ?? null };
      })
      .filter((t) => enough(t.count)),
    years: yearGroups
      .filter(
        (g) =>
          enough(g._count._all) && g.year >= YEAR_RANGE.min && g.year <= YEAR_RANGE.max,
      )
      .map((g) => ({ year: g.year, count: g._count._all, latest: g._max.updatedAt }))
      .sort((a, b) => b.year - a.year),
  };
}

/**
 * 某类目下的经典茶（落地页最多展示 200 条，够覆盖现有 152 款）—— **已按热度排好**。
 *
 * 排序口径与 `/forum/classics` 完全一致（同一份 `sortTeas` + 同一份热度公式），
 * 不在这里另写一套 —— AGENTS.md R28：公式只有一份实现。
 *
 * `CLASSIC` 放在展开的**后面**：调用方传什么都关不掉公开过滤（`isClassic: true` /
 * `deletedAt: null` 是公开面的不变量，不该由调用方决定）。
 * 同样不吞错误：DB 故障时宁可 5xx，也不要给爬虫一个空壳类目页。
 * （热度**统计**那一环例外：读者数取不到时降级为 0，不让统计问题把页面变成 5xx。）
 */
export async function loadClassicTeas(
  where: Record<string, unknown>,
  take = 200,
): Promise<TeaListRow[]> {
  const teas = await prisma.tea.findMany({
    where: { ...where, ...CLASSIC },
    orderBy: [{ tastingNoteCount: "desc" }, { year: "desc" }],
    take,
    select: teaListSelect,
  });
  const heatMap = await loadTeaHeatInputs(
    teas.map((t) => ({
      id: t.id,
      coverImage: t.coverImage,
      gallery: t.gallery,
      tastingNoteCount: t.tastingNoteCount,
    })),
  );
  const now = Date.now();
  return sortTeas(
    teas.map((t) => ({
      ...t,
      ...(heatMap.get(t.id) ?? EMPTY_HEAT(t.id, t.tastingNoteCount)),
    })),
    "heat",
    { now, bucket: Math.floor(now / 3600000) },
  ).slice(0, take);
}

/** 聚合失败时的兜底热度输入（全部归零，排在最后）。 */
function EMPTY_HEAT(id: string, tastingNoteCount = 0): TeaHeatInput {
  return {
    id,
    netVotes: 0,
    replyCount: 0,
    realReaders: 0,
    hasMedia: false,
    lastActivity: new Date(0),
    tastingNoteCount,
  };
}
