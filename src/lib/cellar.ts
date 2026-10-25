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
import { toCsv } from "./tasting-corrections.ts";

/**
 * 词表**只有一份**：阶段/对照/器具的取值与标签都在
 * `src/lib/tasting-extract/vocab.ts`（F1 已经落库，站长按那份复核过 522 行）。
 * 这里不再转发 —— 多一条 import 路径就多一处可能漂移的地方。
 * 需要词表的文件直接 import `./tasting-extract/vocab.ts`。
 */

/**
 * 仓储评分的来源：自评（用户自己打的）/ 站长评。
 *
 * 这个联合类型是 DB 里那条 CHECK 约束的镜像（见
 * `prisma/migrations/20261023_cellar/migration.sql` 的
 * `storage_epochs_assessedBy_check`）。
 *
 * **代录已取消**（2026-10-23 站长拍板），所以现在新写入的评分恒为「自评」；
 * 「站长评」只可能来自更早的存量数据。保留这个取值是为了别把那段历史
 * 改写成假的 —— 它记的是**当时**这条评分是谁给的。
 */
export type AssessedBy = "self" | "editor";

// ─── 仓储评分（PRD §6）────────────────────────────────────────────────────

/**
 * 储仓评分的四个锚点。
 *
 * 范围 45–60，采用「标准偏干」概念而不是港式四分法（站长判断前者更适合
 * 90 年代前的老茶）。评分由**人**给，不由 LLM 从笔记推断。
 *
 * ## 这四个数是数轴上的参考点，不是四个取值
 *
 * 45–60 之间**任意整数**都合法（47、52、58 都行）。锚点只是四个方便的
 * 参照位置，标尺上的位置换算用 `storageScalePercent`。
 * 2026-10-24 站长明确纠正过这一点：「实际是一个数轴，左边最低 45，最右边
 * 60，中间任何一个状态都可以」—— 早先的四个按钮把它做成了四档，那是错的。
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
  { score: 45, label: "偏干", desc: "（占位）仓储偏干，转化慢但不易霉变" },
  { score: 50, label: "标准干仓", desc: "（占位）干仓，转化节奏正常" },
  { score: 55, label: "偏湿", desc: "（占位）仓储偏湿，转化快，需留意霉变" },
  { score: 60, label: "湿仓", desc: "（占位）湿仓，转化快，适合即饮" },
] as const;

/**
 * 档名的两个**分界点**（2026-10-24 站长定的口径）。
 *
 * 「标准干仓」是 50、「偏湿」是 55 —— 这两个数既是锚点，也是档名分段
 * 的边界。「必须与锚点一致」这条由 `src/lib/cellar.test.ts` 钉住。
 */
export const STORAGE_DRY_SCORE = 50;
export const STORAGE_WET_SCORE = 55;

/** 仓储评分的取值范围（DB 里有同款 CHECK 约束）。 */
export const STORAGE_SCORE_MIN = 45;
export const STORAGE_SCORE_MAX = 60;

/**
 * 未记录时滑块的停靠位置。
 *
 * 50 = 标准仓 —— 四个锚点里唯一「不干不湿」的那个，是用户什么都不改时
 * 最中性的读数。
 *
 * ⚠️ 它**不是** (最小值 + 最大值) / 2 —— 那是几何中点，落在「标准偏湿」
 * 那一侧，暗示得比实际更湿。50 是**有语义的选择**，不是算出来的。
 *
 * 「必须等于标准仓锚点」这条由 `src/lib/cellar.test.ts` 钉住 ——
 * 锚点集合一改，这个常量会静默变成另一个意思。
 */
export const STORAGE_DEFAULT_SCORE = 50;

// ─── 品鉴记录的共享上限 ───────────────────────────────────────────────────
//
// 这些数字**只有一份**：zod 的 schema 与客户端表单都用它们。
// 之前两边各写一遍，改上限时两边会分叉 —— 客户端以为能传 20 张，
// 服务端打回 400，用户填的阶段、备注一起丢。

/** 一条品鉴记录最多几张图片。 */
export const CELLAR_MAX_IMAGES = 9;
/** 一条品鉴记录最多几段视频。 */
export const CELLAR_MAX_VIDEOS = 3;
/** 每个维度最多几个关键词。 */
export const CELLAR_MAX_DIM_TAGS = 20;
/** 摊平后的描述词总数上限（四个维度 + 通用词）。 */
export const CELLAR_MAX_DESCRIPTORS = 100;
/** 快速品鉴耗时上限（秒）。 */
export const CELLAR_MAX_ELAPSED_SECONDS = 86400;

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
 * 仓储评分的**档名**（标尺读数、列表徽章、详情页、导出都用它）。
 *
 * 2026-10-24 站长定的口径 —— 锚点是四个**参考点**，档名是把数轴分段后
 * 的说法：
 *
 *   45–49   标准偏干
 *   50      标准干仓
 *   51–54   标准偏湿
 *   55      偏湿
 *   56–60   湿仓
 *
 * ⚠️ 档名**不是**最近锚点的名字：47 的最近锚点是 45（「偏干」），
 * 但 47 落在「标准偏干」这一段。锚点名是**那个点**的名字，档名是
 * **那一段**的名字 —— 两套说法，别混。
 */
export function storageBandLabel(score: number | null): string {
  if (score === null) return "未记录";
  if (score < STORAGE_DRY_SCORE) return "标准偏干";
  if (score === STORAGE_DRY_SCORE) return "标准干仓";
  if (score < STORAGE_WET_SCORE) return "标准偏湿";
  if (score === STORAGE_WET_SCORE) return "偏湿";
  return "湿仓";
}

/**
 * 仓储评分在数轴上的位置（0–1）。
 *
 * **最小值在最左（最干），最大值在最右（最湿）**，中间任意值连续分布 ——
 * 这正是 2026-10-24 站长纠正的那件事：45/50/55/60 是数轴上的四个参考点，
 * 不是四个档位。UI 画刻度、画填充条都用这一个换算，别各处自己写
 * `(score - 45) / 15` —— 那正是「四档」写法的来源。
 *
 * **「什么算合法仓储分」只有一份口径**：`normalizeStorageScore`。
 * 本函数直接复用它，所以越界、非整数、NaN 一律返回 null ——
 * 「画图坐标宽松一点」不是另一套标准，只会让两处口径悄悄分叉。
 *
 * ⚠️ 它因此**不是**一个宽松的绘图坐标：非法分的刻度会整个消失，而不是
 * 被挤到端点。锚点恒为合法值（`src/lib/cellar.test.ts` 有断言），真出现
 * 不合法分说明数据出问题了，不该被悄悄画成「在左边」。
 */
export function storageScalePercent(score: number | null): number | null {
  const n = normalizeStorageScore(score);
  if (n === null) return null;
  return (n - STORAGE_SCORE_MIN) / (STORAGE_SCORE_MAX - STORAGE_SCORE_MIN);
}

/**
 * 仓储评分的展示串 —— 「47 · 标准偏干」。
 *
 * **必须带数字**：只显示标签会把 45 和 47 变成同一个东西，而它们是不同的
 * 仓储状态（连续数轴，见 `STORAGE_ANCHORS` 的说明）。
 *
 * 展示格式只有这一份 —— 列表徽章、详情页当前仓储、换仓历史、滑块读数
 * 全部调它。分叉出去的每一处都是「改了一处忘了另一处」的种子。
 */
export function storageScoreLabel(score: number | null): string {
  if (score === null) return "未记录";
  return `${score} · ${storageBandLabel(score)}`;
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

// ─── 品鉴间隔（PRD §6「两次品鉴至少隔一天」）────────────────────────────────

/** 两次品鉴记录之间至少间隔的小时数。 */
export const TASTING_MIN_INTERVAL_HOURS = 24;

/** 两次品鉴记录之间至少间隔的毫秒数。 */
export const TASTING_MIN_INTERVAL_MS =
  TASTING_MIN_INTERVAL_HOURS * 60 * 60 * 1000;

/**
 * 上一次品鉴之后，最早可以再记一条的时刻。
 *
 * 没有上一次 → null（随时可以记第一条）。
 *
 * ⚠️ 这个「上一次」必须取**服务端写入的 createdAt**，不能用客户端传来的
 * tastedAt —— tastedAt 是客户端给的，伪造一个一年前的时间就能绕过间隔。
 */
export function nextTastingAllowedAt(
  lastCreatedAt: Date | string | null | undefined,
): Date | null {
  if (lastCreatedAt === null || lastCreatedAt === undefined) return null;
  const t =
    lastCreatedAt instanceof Date ? lastCreatedAt : new Date(lastCreatedAt);
  if (Number.isNaN(t.getTime())) return null;
  return new Date(t.getTime() + TASTING_MIN_INTERVAL_MS);
}

/**
 * 距「可以再记」还差多少毫秒。
 *
 * 已经能记了（或者从来没记过）→ null。
 */
export function tastingWaitRemainingMs(
  lastCreatedAt: Date | string | null | undefined,
  now: Date = new Date(),
): number | null {
  const allowedAt = nextTastingAllowedAt(lastCreatedAt);
  if (!allowedAt) return null;
  const remain = allowedAt.getTime() - now.getTime();
  return remain > 0 ? remain : null;
}

/** 「还需 12 小时」/「还需 25 分钟」—— 给人看的提示。 */
export function formatWaitRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "现在就可以记";
  // 满一小时才用小时计（向上取整，早一分钟也不让人以为能记了）；
  // 不足一小时就用分钟 —— 否则「还差 30 分钟」会被说成「还需 1 小时」。
  if (ms >= 3_600_000) return `还需 ${Math.ceil(ms / 3_600_000)} 小时`;
  const minutes = Math.ceil(ms / 60_000);
  return minutes <= 1 ? "不到 1 分钟" : `还需 ${minutes} 分钟`;
}

/**
 * 间隔提示的**整句话** —— 服务端与客户端共用一份。
 *
 * 「24 小时」这个数字来自 `TASTING_MIN_INTERVAL_HOURS`，不再各写一遍：
 * 改成 12 或 48 小时时，两边的提示会一起变。
 */
export function formatWaitMessage(ms: number): string {
  return `上一条品鉴记录创建满 ${TASTING_MIN_INTERVAL_HOURS} 小时才能再记一条（${formatWaitRemaining(ms)}）`;
}

/**
 * 按**创建时刻**取最近的一条品鉴记录。
 *
 * ## 为什么按创建时刻而不是品鉴时刻
 *
 * `tastedAt` 是客户端给的，伪造一个一年前的时间就能把它顶到时间轴的
 * 任何位置。`createdAt` 是数据库写的，客户端碰不到。
 *
 * 服务端那道闸门（`addTastingGuarded`）用的是 `orderBy createdAt desc`，
 * 这里就是同一把尺子在客户端的对应物 —— 一条规则一个地方，别各写一遍。
 *
 * @param tastings 至少要有 `createdAt` 字段
 */
export function latestTastingByCreatedAt<
  T extends { createdAt: string },
>(tastings: T[]): T | null {
  let best: T | null = null;
  let bestMs = -Infinity;
  for (const t of tastings) {
    const ms = new Date(t.createdAt).getTime();
    // createdAt 缺失/坏掉时跳过 —— 拿一个坏时间当基准会让倒计时失准。
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = t;
    }
  }
  return best;
}

/**
 * 选中/取消一个维度关键词后的**下一份** dimTags。
 *
 * 取消掉最后一个词时，这一维整个从 map 里消失 —— 空数组留着的话，
 * 读端会以为「这一维选过词但没选出来」。
 */
export function toggleDimTag(
  prev: Record<string, string[]>,
  dim: string,
  tag: string,
): Record<string, string[]> {
  const cur = prev[dim] ?? [];
  const next = cur.includes(tag)
    ? cur.filter((t) => t !== tag)
    : [...cur, tag];
  const out = { ...prev };
  if (next.length) out[dim] = next;
  else delete out[dim];
  return out;
}

/**
 * 把「按维度选的词」与「通用词」组装成提交用的两份数据。
 *
 * ## 为什么要在客户端夹住上限
 *
 * 服务端 zod 限死了「每维 20 个词、摊平后 100 个」，而词库里光是「滋味」
 * 就有七十多个 —— 用户在「更多词」里全勾上，一点就到 21 个。
 * 服务端会 400 打回**整条请求**：四维分数、长文字、已经传完的图片视频
 * 一起丢。所以上限必须在客户端先夹住。
 *
 * 上限的常量与服务端共用一份（`CELLAR_MAX_DIM_TAGS` /
 * `CELLAR_MAX_DESCRIPTORS`），两边不会漂。
 */
export function buildTastingTags(
  dimTags: Record<string, string[]>,
  free: string[],
): { dimTags: Record<string, string[]>; descriptors: string[] } {
  const capped: Record<string, string[]> = {};
  for (const key of DIM_KEYS) {
    const arr = (dimTags[key] ?? []).slice(0, CELLAR_MAX_DIM_TAGS);
    if (arr.length) capped[key] = arr;
  }
  // 摊平：四个维度 + 通用词，去重。两个维度选了同一个词，摊平后只留一份。
  const flat = [
    ...Object.values(capped).flat(),
    ...free.slice(0, CELLAR_MAX_DIM_TAGS),
  ].filter((t, i, arr) => arr.indexOf(t) === i);
  return { dimTags: capped, descriptors: flat.slice(0, CELLAR_MAX_DESCRIPTORS) };
}

// ─── 复饮提醒间隔（PRD §6 F4）────────────────────────────────────────────

/** 默认提醒间隔（月）。 */
export const DEFAULT_REMIND_MONTHS = 6;

/**
 * 提醒间隔的上限（月）—— 与 DB 的 CHECK 约束一致。
 * 0 = 不提醒（用户可以关掉复饮提醒）。
 */
export const MAX_REMIND_MONTHS = 60;

/**
 * 根据最近一次品鉴结果建议的提醒间隔。
 *
 * PRD：「最近一次为『更好』时建议缩短间隔，为『走下坡』时建议尽快喝」。
 * 这里只给**建议**，不自动改用户的设置 —— 自动改会让人措手不及。
 *
 * `base = 0` 表示用户关了提醒 → 返回 0（**不给建议**）。
 * 以前这里会静默变成 6 个月，用户明明关掉了提醒，界面却建议「每 6 个月」。
 */
export function suggestRemindMonths(
  lastDelta: string | null | undefined,
  base: number = DEFAULT_REMIND_MONTHS,
): number {
  if (base === 0) return 0;
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

/**
 * 词库按维度分组 —— 品鉴表单的「每个维度一摞词」用它。
 *
 * ## 规则
 *
 *   - `dim` 是四个维度之一 → 归到那一维
 *   - `dim` 是 `any` 或空 → **通用词**（不属于任何一维）
 *   - `dim` 是别的值 → 丢掉（词库里的维度名坏了，别让它出现在界面上）
 *
 * 这条规则以前写在品鉴详情页的 useEffect 里 —— 既测不到，也对词库接口的
 * 其它消费者不可见。放在这儿，组件只管调。
 */
export function groupVocabByDim(
  entries: { tag: string; dim?: string | null }[],
): { byDim: Partial<Record<DimKey, string[]>>; free: string[] } {
  const byDim: Partial<Record<DimKey, string[]>> = {};
  const free: string[] = [];
  for (const e of entries) {
    if (!e.tag) continue;
    if (!e.dim || e.dim === "any") {
      free.push(e.tag);
      continue;
    }
    if (!(DIM_KEYS as readonly string[]).includes(e.dim)) continue;
    const key = e.dim as DimKey;
    (byDim[key] ??= []).push(e.tag);
  }
  return { byDim, free };
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
  /** 摊平的描述词（所有维度 + 通用词）。 */
  descriptors: string[];
  /** 按维度归类的描述词 —— 「这个词属于哪一维」在这里。 */
  dimTags: Record<string, string[]>;
  grams: number | null;
  vessel: string | null;
  note: string | null;
  images: string[];
  videos: string[];
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
  /** 当前仓储期（最新一条），方便直接看。 */
  currentStorage: ExportStorage | null;
  /**
   * 全部仓储期（按 startsAt 升序）。
   *
   * 换仓是**新增一条**、旧的保留 —— 所以历史必须一起导出。只导
   * currentStorage 会把「这饼茶去年在哪个仓」这段历史悄悄丢掉，
   * 而那正是仓储这条线存在的意义。
   */
  epochs: ExportStorage[];
  tastings: ExportTasting[];
}

/**
 * 导出 CSV 的表头 —— **拆成两段**。
 *
 * 一行 = 一条品鉴记录 × 一个仓储期，所以表头天然分两块：条目/仓储信息
 * 在前，品鉴信息在后。拆开命名之后，行宽与补空位的列数都从这两段**算**
 * 出来，不再手写数字 —— 写死的话，往前段加一列，后面所有品鉴列会静默错位。
 *
 * ⚠️ 表头**不能重名**：CSV 解析成对象时同名的列后者覆盖前者，
 * 一份数据就凭空少一列。所以条目备注与品鉴备注必须分开命名。
 */
export const CELLAR_EXPORT_BASE_HEADER = [
  "条目ID",
  "茶品",
  "自建名",
  "入仓时间",
  "条目备注",
  "提醒间隔(月)",
  "仓储期序号",
  "仓储期数",
  "仓储评分",
  "仓储档",
  "仓储评分人",
  "城市",
  "容器",
  "仓储起",
] as const;

export const CELLAR_EXPORT_TASTING_HEADER = [
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
  "维度词",
  "投茶量",
  "器具",
  "品鉴备注",
  "图片",
  "视频",
  "可见性",
  "耗时秒",
] as const;

export const CELLAR_EXPORT_CSV_HEADER = [
  ...CELLAR_EXPORT_BASE_HEADER,
  ...CELLAR_EXPORT_TASTING_HEADER,
];

/**
 * 维度词在导出里的写法 —— 「香气:蜜香/花香; 滋味:甜」。
 *
 * 摊平后的 `描述词` 列看不出「哪个词属于哪一维」，这一列补上那层信息。
 */
export function formatDimTags(dimTags: Record<string, string[]> | undefined): string {
  if (!dimTags) return "";
  return DIM_KEYS.filter((k) => dimTags[k]?.length)
    .map((k) => `${DIM_LABELS[k]}:${dimTags[k].join("/")}`)
    .join("; ");
}

/**
 * CSV 单元格的值 —— 加一道**公式注入**的防护。
 *
 * 备注、描述词、条目名都是用户写的自由文本。Excel / LibreOffice /
 * Google Sheets 打开 CSV 时，单元格里以 `=` `+` `-` `@` 开头的文本会被
 * 当成**公式**求值（CSV injection）。用户在自己的备注里写「=1+1」，
 * 打开导出表就变成一个算式 —— 看着无害，但同一段代码将来给管理员导出
 * 别人的数据时就是一条可执行路径。
 *
 * 处理办法：前面加一个单引号，Excel 会把它当纯文本。开头是空白或
 * 制表符/回车时同样危险（Excel 会跳过前导空白再判断），所以先剥掉
 * 前导空白再判断。
 */
export function cellarCsvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  const trimmed = s.replace(/^[\s\t\r\n]+/, "");
  if (/^[=+\-@]/.test(trimmed)) return `'${s}`;
  return s;
}

/**
 * 把导出数据铺成 CSV 行。
 *
 * 一行 = 一条品鉴记录 × 一个仓储期。
 *
 * 为什么要交叉：换仓是**新增一条仓储期**、旧的保留。只导最新的那条，
 * 「这饼茶去年在哪个仓」这段历史就没了 —— 而那正是仓储这条线存在的意义。
 * 一个条目通常只有一段仓储期（大多数情况行数不变），换过仓的条目行数
 * 翻倍，每行用「仓储期序号」标清楚是哪一段。
 *
 * 没有仓储期也没有品鉴的条目，也要出一行（否则导出就丢条目）。
 */
export function cellarExportRows(
  items: ExportItem[],
): (string | number | null | undefined)[][] {
  const rows: (string | number | null | undefined)[][] = [];
  // 行宽与补空位的列数都从表头**算**出来，不写死数字。
  const tastingWidth = CELLAR_EXPORT_TASTING_HEADER.length;

  for (const item of items) {
    const epochs = item.epochs.length ? item.epochs : [null];
    const tastings = item.tastings.length ? item.tastings : [null];

    epochs.forEach((epoch, epochIndex) => {
      const base: (string | number | null | undefined)[] = [
        item.id,
        item.teaName ?? "",
        item.name ?? "",
        item.acquiredAt ?? "",
        item.qtyNote ?? "",
        // 0 = 不提醒。导出成人话，别让用户以为「0 个月后提醒」。
        item.remindEveryMonths === 0 ? "不提醒" : item.remindEveryMonths,
        epoch ? epochIndex + 1 : "",
        item.epochs.length,
        epoch?.storageScore ?? "",
        epoch ? storageBandLabel(epoch.storageScore) : "",
        epoch?.assessedBy ?? "",
        epoch?.city ?? "",
        epoch?.container ?? "",
        epoch?.startsAt ?? "",
      ];

      for (const t of tastings) {
        if (!t) {
          rows.push([...base, ...new Array(tastingWidth).fill("")]);
          continue;
        }
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
          formatDimTags(t.dimTags),
          t.grams ?? "",
          t.vessel ?? "",
          t.note ?? "",
          t.images.join(","),
          t.videos.join(","),
          t.visibility,
          t.elapsedSeconds ?? "",
        ]);
      }
    });
  }
  return rows;
}

/** 导出 CSV（带 BOM，Excel 打开不乱码）。 */
export function cellarExportCsv(items: ExportItem[]): string {
  // 公式注入防护在**写出去的最后一步**做 —— 上面铺行时保持原值，
  // 便于对齐检查。
  const rows = cellarExportRows(items).map((r) => r.map(cellarCsvCell));
  return toCsv([...CELLAR_EXPORT_CSV_HEADER], rows);
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
