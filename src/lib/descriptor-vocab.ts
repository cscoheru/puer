/**
 * 描述词库的统计与拼装（PRD v0.3 §5 Phase 2 · F2）。
 *
 * ## 为什么单独一个模块
 *
 * 播种脚本 `scripts/seed-descriptor-vocab.mjs` 要连库、要调 LLM，
 * 没法离线单测。但它里面最容易出错、也最不该出错的是**纯算术**：
 *
 *   1. 一个词在生普与熟普里的次数**各算各的**；
 *   2. 年份段**按生熟分开**看分布 —— 「烟香」多见于老生普、「堆味」多见于
 *      新熟普，用合并后的分布会给其中一个生熟写上错的年份段；
 *   3. 一个词出现过的每个生熟各出一行（库里 `tag + category` 是唯一键）。
 *
 * 这三件事错任何一件，产出都**不会报错**：表照写、库照写，只是词库说谎。
 * 所以它们放在这里，配一份单测；脚本只负责取数、调模型、落库。
 *
 * ## 一次真实的翻车
 *
 * 2026-10-23 的重构把统计结构从扁平的 `{count, raw, ripe, brackets}` 改成
 * 嵌套的 `{total, cats:{raw:{count,brackets}, ripe:{...}}}`（为了按生熟分开
 * 算年份段），但拼装那几行**没跟着改**，还在读已经不存在的 `e.raw`。
 * `undefined > 0` 是 `false` → 每行的生熟列表都是空 → **整份词库一行都没写**，
 * 而脚本正常退出、正常打印「已写入 0 条」。
 *
 * 这就是本文件存在的理由：把算术抽出来，让它**必须**被测到。
 */

import { toCsv } from "./tasting-corrections.ts";

// ─── 类型 ─────────────────────────────────────────────────────────────────

export type VocabCategory = "raw" | "ripe";

export type VocabAgeBracket = "young" | "mid" | "aged" | "any";

/** 四个维度 + `any`（「通用」，跨维度或不属于任何一维）。 */
export type VocabDim = "aroma" | "flavor" | "waterPath" | "bodyFeel" | "any";

/** 词表里实际会落的值（`any` 不是维度之一，它是兜底归类）。 */
export const VOCAB_DIMS: readonly VocabDim[] = [
  "aroma",
  "flavor",
  "waterPath",
  "bodyFeel",
  "any",
];

/** 一个生熟下的统计。 */
export interface CategoryStat {
  /** 该生熟下这个词出现了多少次。 */
  count: number;
  /** 年份段分布：`{ aged: 12, mid: 3 }`。 */
  brackets: Record<string, number>;
}

/** 一个词在所有生熟上的统计。 */
export interface WordStat {
  /** 跨生熟的总次数（用来筛高频词）。 */
  total: number;
  cats: Record<VocabCategory, CategoryStat>;
}

/** 落库/报告的一行。 */
export interface VocabRow {
  tag: string;
  category: VocabCategory;
  ageBracket: VocabAgeBracket;
  dim: VocabDim;
  /** 该生熟下的次数（不是跨生熟的总次数）。 */
  count: number;
  /** `llm` = 模型判过维度；`seed` = 模型没给/分类失败，退回「通用」。 */
  source: "llm" | "seed";
}

/** 取数时用到的最小笔记形状（脚本从 Prisma 查出来的就是这个样子）。 */
export interface NoteLike {
  descriptors?: unknown;
  tea?: { type?: string | null; year?: number | null } | null;
}

// ─── 参数 ─────────────────────────────────────────────────────────────────

/**
 * 年份段：按茶的年份划。
 *
 * 2020 及以后 = 新茶；2010–2019 = 中段；更早 = 老茶；没有年份 = 未知。
 */
export function ageBracketOf(year: number | null | undefined): VocabAgeBracket {
  if (year == null || !Number.isFinite(year)) return "any";
  if (year >= 2020) return "young";
  if (year >= 2010) return "mid";
  return "aged";
}

/**
 * 一个生熟下，年份段分布太散就归 `any` 的阈值。
 *
 * 取该生熟里出现最多的那个年份段，但只有它占比 ≥ 0.6 才采信 —— 否则
 * 「这个词在生普里既有老茶又有新茶」就说明它本身不是某一年的特征，
 * 硬按多数派写会误导用户按年份段筛词。
 */
export const AGE_BRACKET_MIN_SHARE = 0.6;

/** 一个词最多长什么样（超过就是句子而不是描述词了）。 */
const MAX_TAG_LENGTH = 20;

// ─── 统计 ─────────────────────────────────────────────────────────────────

function emptyStat(): WordStat {
  return {
    total: 0,
    cats: {
      raw: { count: 0, brackets: {} },
      ripe: { count: 0, brackets: {} },
    },
  };
}

/**
 * 统计一批笔记里的描述词频次与分布。
 *
 * **按生熟分开统计**：同一个词在生普与熟普里的年份分布常常完全不同，
 * 用合并后的分布会给其中一个生熟写上错的年份段。
 */
export function collectWordStats(notes: NoteLike[]): Map<string, WordStat> {
  const map = new Map<string, WordStat>();

  for (const n of notes) {
    const list = Array.isArray(n.descriptors)
      ? n.descriptors.filter((x): x is string => typeof x === "string")
      : [];
    const cat: VocabCategory = n.tea?.type === "ripe" ? "ripe" : "raw";
    const bracket = ageBracketOf(n.tea?.year);

    for (const raw of list) {
      const tag = raw.trim();
      if (!tag || tag.length > MAX_TAG_LENGTH) continue;

      let e = map.get(tag);
      if (!e) {
        e = emptyStat();
        map.set(tag, e);
      }
      e.total++;
      const c = e.cats[cat];
      c.count++;
      c.brackets[bracket] = (c.brackets[bracket] ?? 0) + 1;
    }
  }

  return map;
}

/**
 * 挑出够格的词：出现次数 ≥ minCount，取前 limit 个（按次数降序）。
 */
export function pickFrequentWords(
  stats: Map<string, WordStat>,
  opts: { minCount?: number; limit?: number } = {},
): [string, WordStat][] {
  const minCount = opts.minCount ?? 3;
  const limit = opts.limit ?? 120;

  return [...stats.entries()]
    .filter(([, e]) => e.total >= minCount)
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0], "zh"))
    .slice(0, limit);
}

/**
 * 该生熟下采信哪个年份段。
 *
 * 分布太散（最多的一段占比 < 0.6）就返回 `any`。
 */
export function pickAgeBracket(
  brackets: Record<string, number>,
  minShare: number = AGE_BRACKET_MIN_SHARE,
): VocabAgeBracket {
  const entries = Object.entries(brackets);
  if (!entries.length) return "any";

  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total <= 0) return "any";

  const [topTag, topCount] = entries.sort((a, b) => b[1] - a[1])[0];
  if (topCount / total < minShare) return "any";
  return topTag as VocabAgeBracket;
}

/**
 * 把统计拼成落库/报告的行。
 *
 * **每个词 × 它出现过的每个生熟 = 一行**（`tag + category` 是库里的唯一键）。
 * 每个生熟拿自己的次数与自己的年份段分布 —— 这两件事都**不能**跨生熟合并。
 *
 * @param kept  [词, 统计] 列表（一般来自 `pickFrequentWords`）
 * @param dims  模型判定的维度；没判到（或判失败）时用 `any` + `source: "seed"`
 */
export function buildVocabRows(
  kept: [string, WordStat][],
  dims: Map<string, VocabDim> = new Map(),
): VocabRow[] {
  const rows: VocabRow[] = [];

  for (const [tag, e] of kept) {
    const dim = dims.get(tag) ?? "any";
    const source: VocabRow["source"] = dims.has(tag) ? "llm" : "seed";

    for (const cat of ["raw", "ripe"] as const) {
      const c = e.cats[cat];
      if (c.count <= 0) continue; // 这个生熟下没出现过 → 不出这一行

      rows.push({
        tag,
        category: cat,
        ageBracket: pickAgeBracket(c.brackets),
        dim,
        count: c.count,
        source,
      });
    }
  }

  return rows;
}

// ─── 报告（给站长核对）─────────────────────────────────────────────────────

export const VOCAB_CSV_HEADER = ["词", "生熟", "年份段", "维度", "出现次数"];

/**
 * 拼给站长核对的 CSV（Excel 能直接打开）。
 *
 * 用 `toCsv` 而不是自己拼字符串 —— 转义与 BOM 只有一份实现，
 * 免得这边带引号那边不带，Excel 打开就串列。
 */
export function renderVocabCsv(rows: VocabRow[]): string {
  return toCsv(
    VOCAB_CSV_HEADER,
    rows.map((r) => [r.tag, r.category, r.ageBracket, r.dim, r.count]),
  );
}
