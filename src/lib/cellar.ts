/**
 * F2「我的茶仓」的纯函数（PRD v0.3 §5 Phase 2）。
 *
 * ## 为什么要分纯/脏两层
 *
 * `cellar-data.ts` 碰数据库，`src/lib/prisma.ts` 在 import 时就实例化
 * PrismaClient —— 两者混在一起就没法离线单测。所以规则全放这里：
 * API 路由、后台页面、导出脚本、报表脚本都调同一份实现。
 *
 * 这个模块**不 import 任何运行时依赖**（只用相对路径引 `vocab.ts` 与
 * `tasting-corrections.ts`），可被裸 `node --test` 直接跑。
 *
 * ## 三条不能破的规则
 *
 * 1. **口径写在数据里**。储仓评分 45–60、四维 1–10、阶段/对照枚举都有
 *    明确取值范围，DB 里有 CHECK 约束，这里也校验 —— 两层都挡住才算数。
 * 2. **综合分只在四维齐全时给**。两维的均值和三维的均值不在同一个刻度上，
 *    混着比就是在制造假精度（PRD §4「永不平均」）。
 * 3. **词表只有一份**。阶段/对照/器具沿用 F1 的 `vocab.ts`，不另起一套。
 */

// 相对路径：这个文件要被裸 node 直接跑单测（npm run test:unit 不带 tsx），
// 路径别名 @/ 在那里解析不了。
import {
  DELTA_LABELS,
  STAGE_LABELS,
  type Delta,
  type Stage,
} from "./tasting-extract/vocab.ts";
import { toCsv } from "./tasting-corrections.ts";

export { DELTA_LABELS, STAGE_LABELS };
export type { Delta, Stage };

// ─── 仓储评分（PRD §6）────────────────────────────────────────────────────

/**
 * 储仓评分的四个锚点。
 *
 * 范围 45–60，采用「标准偏干」概念而不是港式四分法（站长判断前者更适合
 * 90 年代前的老茶）。评分由**人**给，不由 LLM 从笔记推断。
 *
 * ⚠️ `desc` 是**占位文案** —— PRD §6 写明锚点描述由站长提供，CC 先放占位
 * 并在 PR 中标出。改这里之前先问站长。
 */
export interface StorageAnchor {
  score: number;
  label: string;
  desc: string;
}

export const STORAGE_ANCHORS: readonly StorageAnchor[] = [
  { score: 45, label: "标准偏干", desc: "（占位）仓储偏干，转化慢但不易霉变" },
  { score: 50, label: "标准仓", desc: "（占位）不干不湿，转化节奏正常" },
  { score: 55, label: "标准偏湿", desc: "（占位）仓储偏湿，转化快，需留意霉变" },
  { score: 60, label: "湿仓", desc: "（占位）湿仓，转化快，适合即饮" },
] as const;

/** 仓储评分的取值范围（DB 里有同款 CHECK 约束）。 */
export const STORAGE_SCORE_MIN = 45;
export const STORAGE_SCORE_MAX = 60;

/**
 * 规整储仓评分。越界或非整数一律返回 null —— 宁空勿猜。
 *
 * 中间值（47、48、52…）是**允许的**：PRD 只给了四个锚点，但允许选中间值。
 */
export function normalizeStorageScore(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n < STORAGE_SCORE_MIN || n > STORAGE_SCORE_MAX) return null;
  return n;
}

/**
 * 找最接近的锚点。
 *
 * 整数分值下四个锚点的中点是 47.5 / 52.5 / 57.5，落在两个整数之间，
 * 所以**不会出现平局**，不需要额外的 tie-break 规则。
 */
export function storageAnchorOf(score: number | null): StorageAnchor | null {
  if (score === null) return null;
  let best: StorageAnchor | null = null;
  let bestDist = Infinity;
  for (const a of STORAGE_ANCHORS) {
    const d = Math.abs(a.score - score);
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  return best;
}

/** 储仓分档名（Phase 3 社区带按最近锚点分四组）。 */
export function storageBandLabel(score: number | null): string {
  return storageAnchorOf(score)?.label ?? "未记录";
}

// ─── 四维评分（PRD §6）────────────────────────────────────────────────────

/**
 * 四个维度。生普、熟普、不同年份统一用这四维，分值可跨茶比较。
 * 差异只在描述用词（见 DescriptorVocab）。
 */
export const DIM_KEYS = ["aroma", "flavor", "waterPath", "bodyFeel"] as const;
export type DimKey = (typeof DIM_KEYS)[number];

export const DIM_LABELS: Record<DimKey, string> = {
  aroma: "香气",
  flavor: "滋味",
  waterPath: "水路",
  bodyFeel: "体感",
};

/** 每维的取值范围。 */
export const DIM_MIN = 1;
export const DIM_MAX = 10;

export type CellarDims = Partial<Record<DimKey, number>>;

export interface DimsParseResult {
  dims: CellarDims | null;
  errors: string[];
}

/**
 * 校验四维输入。
 *
 * 逐项检查：必须在 1–10 的**整数**区间内；出现未知键直接报错而不是忽略 ——
 * 拼错的键（`water_path`）如果被静默忽略，用户会以为自己打了分。
 */
export function parseDims(raw: unknown): DimsParseResult {
  const errors: string[] = [];
  if (raw === null || raw === undefined) return { dims: null, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { dims: null, errors: ["四维评分必须是一个对象"] };
  }

  const src = raw as Record<string, unknown>;
  const dims: CellarDims = {};

  for (const key of Object.keys(src)) {
    if (!(DIM_KEYS as readonly string[]).includes(key)) {
      errors.push(`未知维度：${key}`);
      continue;
    }
    const v = src[key];
    if (v === null || v === undefined) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      errors.push(`${DIM_LABELS[key as DimKey]}必须是整数`);
      continue;
    }
    if (n < DIM_MIN || n > DIM_MAX) {
      errors.push(`${DIM_LABELS[key as DimKey]}必须在 ${DIM_MIN}–${DIM_MAX} 之间`);
      continue;
    }
    dims[key as DimKey] = n;
  }

  if (Object.keys(dims).length === 0) {
    return { dims: null, errors };
  }
  return { dims, errors };
}

/**
 * 综合分 = 四维均值（一位小数）。
 *
 * **只在四维齐全时给**：两维均值与三维均值不在同一刻度上，
 * 缺一维还照样给综合分就是在制造假精度（PRD §4「永不平均」）。
 */
export function overallScore(dims: CellarDims | null | undefined): number | null {
  if (!dims) return null;
  let sum = 0;
  for (const key of DIM_KEYS) {
    const v = dims[key];
    if (typeof v !== "number") return null;
    sum += v;
  }
  return Math.round((sum / DIM_KEYS.length) * 10) / 10;
}

/** 四维是否齐全。 */
export function hasAllDims(dims: CellarDims | null | undefined): boolean {
  return overallScore(dims) !== null;
}

// ─── 快速品鉴的默认值（PRD §6「默认沿用上次」）──────────────────────────

export interface TastingDefaults {
  grams: number | null;
  vessel: string | null;
  descriptors: string[];
}

/**
 * 快速品鉴的可选项默认值 —— 沿用上一次。
 *
 * PRD：「可选项：四维评分…与描述词点选、备注、图片、投茶量、器具
 * （默认沿用上次）」。沿用能省一次输入，也保证同一条茶的记录口径不乱跳。
 */
export function nextTastingDefaults(
  prev: {
    grams?: number | null;
    vessel?: string | null;
    descriptors?: string[] | null;
  } | null
  | undefined,
): TastingDefaults {
  if (!prev) return { grams: null, vessel: null, descriptors: [] };
  return {
    grams: prev.grams ?? null,
    vessel: prev.vessel ?? null,
    descriptors: Array.isArray(prev.descriptors)
      ? prev.descriptors.filter((x): x is string => typeof x === "string")
      : [],
  };
}

// ─── 复饮提醒间隔（PRD §6 F4）────────────────────────────────────────────

/** 默认提醒间隔（月）。 */
export const DEFAULT_REMIND_MONTHS = 6;

/**
 * 根据最近一次品鉴结果建议的提醒间隔。
 *
 * PRD：「最近一次为『更好』时建议缩短间隔，为『走下坡』时建议尽快喝」。
 * 这里只给**建议**，不自动改用户的设置 —— 自动改会让人措手不及。
 */
export function suggestRemindMonths(
  lastDelta: Delta | string | null | undefined,
  base: number = DEFAULT_REMIND_MONTHS,
): number {
  const months = Number.isInteger(base) && base > 0 ? base : DEFAULT_REMIND_MONTHS;
  if (lastDelta === "better") return Math.max(1, Math.floor(months / 2));
  if (lastDelta === "worse") return Math.max(1, Math.floor(months / 3));
  return months;
}

// ─── 描述词库筛选 ─────────────────────────────────────────────────────────

export interface VocabEntry {
  tag: string;
  category: "raw" | "ripe" | "any";
  ageBracket?: string | null;
  dim?: string | null;
}

/**
 * 按生熟/年份段/维度筛描述词。
 *
 * 库里存 `any` 的词对所有生熟都适用，`any` 年份段对所有年份段都适用。
 * 精确匹配优先于 any —— 同一个词若既有生普条目又有 any 条目，生普那条
 * 会排在前面（更具体）。
 */
export function filterVocab(
  entries: VocabEntry[],
  opts: { category?: "raw" | "ripe"; ageBracket?: string; dim?: string } = {},
): VocabEntry[] {
  const { category, ageBracket, dim } = opts;
  const scored = entries
    .map((e) => {
      let score = 0;
      if (category) {
        if (e.category === category) score += 4;
        else if (e.category !== "any") return null;
        else score += 1;
      }
      if (ageBracket) {
        if (e.ageBracket === ageBracket) score += 4;
        else if (e.ageBracket && e.ageBracket !== "any") return null;
        else score += 1;
      }
      if (dim) {
        if (e.dim === dim) score += 4;
        else if (e.dim && e.dim !== "any") return null;
        else score += 1;
      }
      return { e, score };
    })
    .filter((x): x is { e: VocabEntry; score: number } => x !== null);

  scored.sort((a, b) => b.score - a.score || a.e.tag.localeCompare(b.e.tag, "zh"));
  return scored.map((x) => x.e);
}

// ─── 导出（PRD §6「可导出 JSON / CSV」）───────────────────────────────────

export interface ExportStorage {
  startsAt: string;
  storageScore: number | null;
  assessedBy: string;
  city: string | null;
  container: string | null;
  legacyStorageLabel: string | null;
}

export interface ExportTasting {
  id: string;
  tastedAt: string;
  stage: string | null;
  deltaVsPrev: string | null;
  dims: CellarDims | null;
  descriptors: string[];
  grams: number | null;
  vessel: string | null;
  note: string | null;
  images: string[];
  visibility: string;
  elapsedSeconds: number | null;
}

export interface ExportItem {
  id: string;
  teaName: string | null;
  name: string | null;
  acquiredAt: string | null;
  qtyNote: string | null;
  remindEveryMonths: number;
  currentStorage: ExportStorage | null;
  tastings: ExportTasting[];
}

/**
 * 导出 CSV 的表头。
 *
 * 一行 = 一条品鉴记录，条目信息冗余在前面（没有品鉴的条目也出一行，
 * 否则导出就会丢条目）。**描述词用逗号分隔** —— 与 F1 的修正表同一套
 * CSV 约定，Excel 里直接能改。
 *
 * ⚠️ 表头**不能重名**：CSV 解析成对象时同名的列后者覆盖前者，
 * 一份数据就凭空少一列。所以条目备注与品鉴备注必须分开命名。
 */
export const CELLAR_EXPORT_CSV_HEADER = [
  "条目ID",
  "茶品",
  "自建名",
  "入仓时间",
  "条目备注",
  "提醒间隔(月)",
  "仓储评分",
  "仓储档",
  "仓储评分人",
  "城市",
  "容器",
  "仓储起",
  "品鉴ID",
  "品鉴时间",
  "阶段",
  "比上次",
  "香气",
  "滋味",
  "水路",
  "体感",
  "综合",
  "描述词",
  "投茶量",
  "器具",
  "品鉴备注",
  "图片",
  "可见性",
  "耗时秒",
];

/** 把导出数据铺成 CSV 行。 */
export function cellarExportRows(
  items: ExportItem[],
): (string | number | null | undefined)[][] {
  const rows: (string | number | null | undefined)[][] = [];
  // 条目信息占前 12 列，品鉴信息占后 16 列。
  // 空行的列数**按表头算**，不写死数字 —— 写死的话，改了表头就会错位。
  const baseWidth = 12;
  const tastingWidth = CELLAR_EXPORT_CSV_HEADER.length - baseWidth;

  for (const item of items) {
    const st = item.currentStorage;
    const base: (string | number | null | undefined)[] = [
      item.id,
      item.teaName ?? "",
      item.name ?? "",
      item.acquiredAt ?? "",
      item.qtyNote ?? "",
      item.remindEveryMonths,
      st?.storageScore ?? "",
      st ? storageBandLabel(st.storageScore) : "",
      st?.assessedBy ?? "",
      st?.city ?? "",
      st?.container ?? "",
      st?.startsAt ?? "",
    ];
    if (item.tastings.length === 0) {
      rows.push([...base, ...new Array(tastingWidth).fill("")]);
      continue;
    }
    for (const t of item.tastings) {
      rows.push([
        ...base,
        t.id,
        t.tastedAt,
        t.stage ?? "",
        t.deltaVsPrev ?? "",
        t.dims?.aroma ?? "",
        t.dims?.flavor ?? "",
        t.dims?.waterPath ?? "",
        t.dims?.bodyFeel ?? "",
        overallScore(t.dims) ?? "",
        t.descriptors.join(","),
        t.grams ?? "",
        t.vessel ?? "",
        t.note ?? "",
        t.images.join(","),
        t.visibility,
        t.elapsedSeconds ?? "",
      ]);
    }
  }
  return rows;
}

/** 导出 CSV（带 BOM，Excel 打开不乱码）。 */
export function cellarExportCsv(items: ExportItem[]): string {
  return toCsv(CELLAR_EXPORT_CSV_HEADER, cellarExportRows(items));
}

/** 导出 JSON 的载荷。 */
export function cellarExportJson(items: ExportItem[]): {
  version: 1;
  exportedAt: string;
  items: ExportItem[];
} {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    items,
  };
}
