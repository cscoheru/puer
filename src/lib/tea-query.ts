/**
 * 经典茶品列表的共享查询/渲染依赖（P1-6）。
 *
 * 这些定义原先散落在 `forum/classics/page.tsx`（teaSelect / firstTeaImage /
 * heatScore）与 `tea/page.tsx`（BRANDS），新增品牌/生熟/年份落地页后会被
 * 四处引用 —— 抽到一处避免漂移。
 */

/** 茶品列表行需要的字段（Prisma select 白名单，见 AGENTS.md R26 规则 5） */
export const teaListSelect = {
  id: true,
  name: true,
  brand: true,
  year: true,
  batch: true,
  type: true,
  coverImage: true,
  gallery: true, // P2-R6：列表缩略图 fallback 到图库第一张
  avgRating: true,
  tastingNoteCount: true,
  marketInfo: true,
  updatedAt: true,
  _count: { select: { articles: true } },
  // P2-R6：封面/图库皆空时，fallback 到最近品鉴笔记的图片（Evernote 导入茶记是主要图源）
  tastingNotes: {
    select: { images: true },
    orderBy: { createdAt: "desc" as const },
    take: 3,
  },
} as const;

export type TeaListRow = {
  id: string;
  name: string;
  brand: string;
  year: number;
  batch: string | null;
  type: string;
  coverImage: string | null;
  gallery: unknown; // Json 图片数组，缩略图 fallback
  tastingNotes: { images: unknown }[]; // 最近 3 篇品鉴（图源 fallback）
  avgRating: number | null;
  tastingNoteCount: number;
  marketInfo: unknown;
  _count: { articles: number };
};

/** P2-R6 图片预览三级链：正面封面 → 图库第一张 → 最近品鉴笔记第一图，无图 null */
export function firstTeaImage(tea: {
  coverImage: string | null;
  gallery: unknown;
  tastingNotes?: { images: unknown }[];
}): string | null {
  if (tea.coverImage) return tea.coverImage;
  const gallery = Array.isArray(tea.gallery) ? (tea.gallery as unknown[]) : [];
  const galImg = gallery.find((u) => typeof u === "string" && u.length > 0);
  if (galImg) return galImg as string;
  for (const n of tea.tastingNotes ?? []) {
    const imgs = Array.isArray(n.images) ? (n.images as unknown[]) : [];
    const first = imgs.find((u) => typeof u === "string" && u.length > 0);
    if (first) return first as string;
  }
  return null;
}

/** 茶品热度：品鉴数为主 + 评分加权 + 行情快照/跟进帖加成 */
export function heatScore(t: {
  tastingNoteCount: number;
  avgRating: number | null;
  marketInfo: unknown;
  _count?: { articles: number };
}) {
  return (
    t.tastingNoteCount * 10 +
    (t.avgRating ?? 0) * 2 +
    (t.marketInfo ? 3 : 0) +
    (t._count?.articles || 0)
  );
}

/** 按热度就地排序（不改原数组） */
export function sortByHeat<T extends Parameters<typeof heatScore>[0]>(teas: T[]): T[] {
  return [...teas].sort((a, b) => heatScore(b) - heatScore(a));
}

/** 筛选下拉的常用品牌（避免长列表；落地页品牌从 DB groupBy 动态取） */
export const PREFERRED_BRANDS = [
  "大益", "下关", "福今", "陈升号", "宝和祥", "今大福", "勐库戎氏", "中茶", "老班章",
];

/**
 * 生熟归一：库内 `type` 存 raw/ripe，也出现过中文值，统一到 raw|ripe|null。
 */
export function normalizeTeaType(type: string | null | undefined): "raw" | "ripe" | null {
  const t = String(type ?? "").trim().toLowerCase();
  if (t === "raw" || t === "sheng" || t === "生" || t === "生茶") return "raw";
  if (t === "ripe" || t === "shou" || t === "熟" || t === "熟茶") return "ripe";
  return null;
}

export const TEA_TYPE_LABELS: Record<"raw" | "ripe", string> = {
  raw: "生茶",
  ripe: "熟茶",
};

/** 品牌/生熟/年份落地页的最小茶品数——低于此值页面太薄，不建页也不进 sitemap */
export const LANDING_MIN_TEAS = 6;

/**
 * 年份聚合页的有效区间。**三处必须共用同一个常量**：`loadFacets()` 的准入过滤、
 * `sitemap.ts` 的收录、`tea/year/[year]` 的入参校验。否则脏数据（如 1899 或 20230）
 * 会「被 sitemap 收录、点进去 404」—— 这是最伤抓取预算的一种不一致。
 */
export const YEAR_RANGE = { min: 1900, max: 2100 } as const;
