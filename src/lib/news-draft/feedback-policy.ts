/**
 * 「退回反馈 → 下一轮选题规则」的**纯决策逻辑**（零导入、无 DB、无 `@/` 别名）。
 *
 * 与 `plan.ts` 同约定：纯函数模块零导入，`npm run test:unit` 的 `node --test`
 * 才能直接跑；IO 与 DB 全在 `scripts/ai-news-draft.mjs`。
 *
 * ## 为什么要有这个模块
 *
 * 管理员在 `/admin/drafts` 点「退回」并给出**分类 + 原因**。分类不是日志，
 * 是**下一轮选题的输入**：
 *
 * | 分类 | 含义 | 推导出的硬规则 |
 * |---|---|---|
 * | `stale` | 题材过时（例：10 月还在写春茶） | 收紧时效闸 + 启用跨季春茶拦截 |
 * | `unknown_brand` | 非知名茶品 | 要求素材命中库中已知品牌 |
 * | `inaccurate` | 信息不实 | 收紧改写层的数字接地（更严的提示与复核） |
 * | `vague` | 内容太泛 | 提高「具象信号」门槛（数字/品牌/产区/批次） |
 * | `other` | 其他 | 不触发规则，但原因文本进 prompt 当负例 |
 *
 * 推导是**确定性**的：同样的反馈集合必然得出同样的规则集。没有这一步，
 * 「退回」就只是一个标记，反馈永远传不回检索与选题。
 *
 * ## 为什么不直接把反馈塞进 prompt
 *
 * 因为 prompt 里的「请不要写春茶」不是规则，是许愿。真正拦住过时素材的
 * 必须是**闸**：`evaluateMaterial` 在送进模型之前就把它剔掉。
 */

/** 退回分类。前四项驱动硬规则，`other` 只作为负例进 prompt。 */
export type FeedbackCategory =
  | "stale"
  | "unknown_brand"
  | "inaccurate"
  | "vague"
  | "other";

/** 分类白名单（API 侧校验用同一份）。 */
export const FEEDBACK_CATEGORIES: readonly FeedbackCategory[] = [
  "stale",
  "unknown_brand",
  "inaccurate",
  "vague",
  "other",
];

/** 分类的中文标签（后台下拉框展示）。 */
export const FEEDBACK_CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  stale: "题材过时",
  unknown_brand: "非知名茶品",
  inaccurate: "信息不实",
  vague: "内容太泛",
  other: "其他",
};

/**
 * 退回原因的最短长度（码点）。
 *
 * 退回应带一条「为什么」进下一轮选题，2 个字的「不好」没有任何信息量。
 */
export const MIN_FEEDBACK_REASON_LENGTH = 4;

/** 退回原因的最长长度（码点）。避免把整篇正文粘进来。 */
export const MAX_FEEDBACK_REASON_LENGTH = 500;

/**
 * 校验退回分类。非法值返回 null（调用方据此 400）。
 *
 * 刻意**不做**大小写/别名归一化：后台下拉框给的是固定五个值，
 * 归一化只会让「写错的分类」静默通过，而不是报错。
 */
export function parseFeedbackCategory(raw: unknown): FeedbackCategory | null {
  if (typeof raw !== "string") return null;
  return (FEEDBACK_CATEGORIES as readonly string[]).includes(raw)
    ? (raw as FeedbackCategory)
    : null;
}

/**
 * 校验退回原因。
 *
 * 返回 trim 后的文本；不合法返回 null。
 * 空串/过短（少于 `MIN_FEEDBACK_REASON_LENGTH` 个码点）都拒绝——
 * 退回必须说明原因，这是用户明确要求。
 */
export function normalizeFeedbackReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const len = Array.from(trimmed).length;
  if (len < MIN_FEEDBACK_REASON_LENGTH) return null;
  if (len > MAX_FEEDBACK_REASON_LENGTH) return null;
  return trimmed;
}

/** 一条退回反馈（对应 `Article.reviewFeedback` JSON）。 */
export interface FeedbackEntry {
  category: FeedbackCategory;
  reason: string;
  /** 退回人（管理员 id）。 */
  by?: string;
  /** 退回时间（ISO 串）。 */
  at?: string;
}

/**
 * 由退回反馈推导出的筛选规则集。
 *
 * 字段含义：
 *  - `maxAgeDays`：素材最新日期距今超过这个天数即判过时；
 *  - `rejectCrossSeason`：拦截「非春茶季却只讲春茶」的素材；
 *  - `requireKnownBrand`：素材必须命中库中已知品牌；
 *  - `minConcreteSignals`：至少要有多少类具象信号（数字/品牌/产区/批次）；
 *  - `stricterGrounding`：改写层对数字接地更严格（额外要求关键数字留存）。
 */
export interface FeedbackPolicy {
  maxAgeDays: number;
  rejectCrossSeason: boolean;
  requireKnownBrand: boolean;
  minConcreteSignals: number;
  stricterGrounding: boolean;
  /** 推导时用到的反馈条数（审计用；0 表示无反馈、走默认规则）。 */
  samples: number;
}

/**
 * 默认规则集。
 *
 * `maxAgeDays = 120`（约四个月）：覆盖「本季行情 + 上季回顾」的正常跨度，
 * 同时能把 2026 年 3 月的春茶稿在 10 月拦掉。
 *
 * `rejectCrossSeason = true`：**默认就开**，不等反馈攒够。用户在 10 月看到
 * 春茶稿是明确的当期问题，不是需要攒样本才能修的慢性病——反馈分类
 * `stale` 只会把它**更严格**（配合更小的 `maxAgeDays`）。
 */
export const DEFAULT_FEEDBACK_POLICY: FeedbackPolicy = {
  maxAgeDays: 120,
  rejectCrossSeason: true,
  requireKnownBrand: false,
  minConcreteSignals: 1,
  stricterGrounding: false,
  samples: 0,
};

/** 反馈统计窗口（天）。超过这个窗口的反馈不再驱动规则。 */
export const FEEDBACK_WINDOW_DAYS = 30;

/** 触发规则收紧所需的最少反馈条数。 */
export const MIN_FEEDBACK_SAMPLES = 5;

/** 某类反馈占比达到该比例即触发对应收紧。 */
export const FEEDBACK_TRIGGER_RATIO = 0.3;

/** `stale` 反馈触发后收紧到的时效闸（天）。 */
export const STALE_MAX_AGE_DAYS = 60;

/**
 * 由反馈集合推导规则集。
 *
 * 规则：
 *  - 只统计 `FEEDBACK_WINDOW_DAYS` 天内的反馈（按 `at` 判定；没有 `at` 的算进来，
 *    因为它必然是刚产生的）；
 *  - 样本数不足 `MIN_FEEDBACK_SAMPLES` 时**不收紧**——一条反馈不该关死整条管线，
 *    这正是「反馈驱动」最容易被做坏的地方（管理员退稿一次，管线从此不产稿）；
 *  - 任一分类占比达到 `FEEDBACK_TRIGGER_RATIO` 即触发该分类对应的收紧。
 *
 * `requireKnownBrand` 只会被打开、不会被关闭（除非重新推导）。
 */
export function deriveFeedbackPolicy(
  entries: readonly FeedbackEntry[],
  now: number = Date.now(),
): FeedbackPolicy {
  const policy: FeedbackPolicy = { ...DEFAULT_FEEDBACK_POLICY };
  const recent = entries.filter((e) => isWithinWindow(e.at, now));
  policy.samples = recent.length;
  if (recent.length < MIN_FEEDBACK_SAMPLES) return policy;

  const counts: Record<FeedbackCategory, number> = {
    stale: 0,
    unknown_brand: 0,
    inaccurate: 0,
    vague: 0,
    other: 0,
  };
  for (const e of recent) {
    if (e.category in counts) counts[e.category] += 1;
  }

  const ratio = (c: number) => c / recent.length;
  if (ratio(counts.stale) >= FEEDBACK_TRIGGER_RATIO) {
    policy.maxAgeDays = Math.min(policy.maxAgeDays, STALE_MAX_AGE_DAYS);
    policy.rejectCrossSeason = true;
  }
  if (ratio(counts.unknown_brand) >= FEEDBACK_TRIGGER_RATIO) {
    policy.requireKnownBrand = true;
  }
  if (ratio(counts.inaccurate) >= FEEDBACK_TRIGGER_RATIO) {
    policy.stricterGrounding = true;
  }
  if (ratio(counts.vague) >= FEEDBACK_TRIGGER_RATIO) {
    policy.minConcreteSignals = Math.max(policy.minConcreteSignals, 2);
  }
  return policy;
}

/** 反馈是否落在统计窗口内。无 `at` 视为刚发生（算进来）。 */
function isWithinWindow(at: string | undefined, now: number): boolean {
  if (!at) return true;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return true;
  const ageDays = (now - t) / 86_400_000;
  return ageDays <= FEEDBACK_WINDOW_DAYS;
}

// ── 日期抽取 ────────────────────────────────────────────────────────

/** 日期抽取的正则组。顺序有意义：先匹配更长的形态。 */
const DATE_PATTERNS: readonly RegExp[] = [
  /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g,
  /(20\d{2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/g,
  /(20\d{2})\s*年\s*(\d{1,2})\s*月(?!\s*\d)/g,
];

/**
 * 从文本里抽出所有**可解析**的日期。
 *
 * 只认 2000–2099 年：普洱茶的批次号（2601、2405）与年份写法高度相似，
 * 把 `2601` 当成日期会得到 26 年 1 月——荒谬且会污染时效判定。
 *
 * 非法日期（如 2 月 31 日）会被丢弃而不是 rollover 到 3 月。
 */
export function extractDates(text: string): Date[] {
  if (!text) return [];
  const out: Date[] = [];
  for (const re of DATE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const year = Number(m[1]);
      const month = Number(m[2]);
      const day = m[3] !== undefined ? Number(m[3]) : 1;
      const d = buildDate(year, month, day);
      if (d) out.push(d);
    }
  }
  return out;
}

/** 构造 UTC 日期；月份/日期越界或 rollover 时返回 null。 */
function buildDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // rollover 检查：2026-02-31 会变成 2026-03-03，字段对不上就判非法。
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

/**
 * 素材的「最新日期」——它的时效性锚点。
 *
 * 取 `publishedAt` 与正文里所有日期的**最大值**。理由：一条 2026 年 10 月的行情稿
 * 里可能提到「2020 年的老茶」，但这条素材**本身**是新的；反过来，一条挂着
 * 2020 年发布日期、正文却在讲 2026 年行情的素材，其真实内容是新的。
 *
 * 未来日期（超过 `now + 7 天`，如「2027 年预售」）会被忽略——那是期货/预售
 * 口径，不是素材的时效。
 */
export function latestMaterialDate(
  material: { publishedAt?: string; body?: string; title?: string },
  now: number = Date.now(),
): Date | null {
  const dates = extractDates(`${material.title ?? ""} ${material.body ?? ""}`);
  const published = material.publishedAt ? parseDateString(material.publishedAt) : null;
  if (published) dates.push(published);
  const horizon = now + 7 * 86_400_000;
  let latest: Date | null = null;
  for (const d of dates) {
    if (d.getTime() > horizon) continue;
    if (!latest || d.getTime() > latest.getTime()) latest = d;
  }
  return latest;
}

/**
 * 解析一个日期字符串（`2026-10-07` / `2026/10/07` / `2026年10月7日`）。
 * 解析不出来返回 null。
 */
export function parseDateString(raw: string): Date | null {
  const text = raw.trim();
  if (!text) return null;
  for (const re of DATE_PATTERNS) {
    const m = new RegExp(re.source, re.flags.replace("g", "")).exec(text);
    if (m) {
      const d = buildDate(
        Number(m[1]),
        Number(m[2]),
        m[3] !== undefined ? Number(m[3]) : 1,
      );
      if (d) return d;
    }
  }
  const t = Date.parse(text);
  if (Number.isFinite(t)) {
    const d = new Date(t);
    return d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2099 ? d : null;
  }
  return null;
}

/** 距今天数（向下取整，最小 0）。 */
export function ageInDays(date: Date, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - date.getTime()) / 86_400_000));
}

// ── 跨季判定 ────────────────────────────────────────────────────────

/**
 * 春夏茶的月份窗口（2–5 月）。
 *
 * 2 月底到 3 月是明前，4 月是雨前/春尾，5 月上旬谷花茶收尾——所以整个
 * 2–5 月都算「春茶季」。6 月往后到次年 1 月，提春茶就是过时题材。
 */
export const SPRING_MONTHS: readonly number[] = [2, 3, 4, 5];

/** 春茶相关关键词。命中即认为这条素材在讲春茶。 */
export const SPRING_KEYWORDS: readonly string[] = [
  "春茶", "明前", "雨前", "头春", "春毛茶", "春尖", "春料", "春分茶",
  "谷花茶", "早春", "古树春", "台地春",
];

/**
 * 素材是否「过季春茶」。
 *
 * 判定：
 *  1. 正文/标题命中春茶关键词；
 *  2. 当前月份**不在**春茶季（2–5 月）；
 *  3. 素材自身没有落在时效窗内的日期（否则它可能是在讲本季行情顺带提春茶）。
 *
 * 第 3 条是防误杀：10 月的一篇「大益春茶批次货值分析」如果正文里有 10 月的
 * 行情数据，它是有价值的当期内容，不该因为出现「春茶」两个字被毙掉。
 */
export function isCrossSeasonMaterial(
  material: { title?: string; body?: string; publishedAt?: string },
  now: number = Date.now(),
  maxAgeDays: number = DEFAULT_FEEDBACK_POLICY.maxAgeDays,
): boolean {
  const text = `${material.title ?? ""} ${material.body ?? ""}`;
  if (!SPRING_KEYWORDS.some((k) => text.includes(k))) return false;
  const month = new Date(now).getUTCMonth() + 1;
  if (SPRING_MONTHS.includes(month)) return false;
  const latest = latestMaterialDate(material, now);
  if (latest && ageInDays(latest, now) <= maxAgeDays) return false;
  return true;
}

// ── 品牌匹配 ────────────────────────────────────────────────────────

/**
 * 库中一个品牌的统计（由脚本从 `teas` 表聚合而来）。
 *
 * `count` = 该品牌在库中的茶品数（知名度的粗略代理：357 的大益显然比
 * 1 条记录的杂牌更「知名」）；`classicCount` = 其中被标为经典普洱的数量。
 */
export interface BrandStat {
  brand: string;
  count: number;
  classicCount: number;
}

/** 品牌匹配结果。 */
export interface BrandScore {
  /** 命中品牌列表（按得分降序）。 */
  matched: string[];
  /** 命中的经典茶品名（`isClassic`）。 */
  classicHits: string[];
  /** 加权总分（用于排序候选）。 */
  score: number;
  /** 得分最高的品牌。 */
  top: string | null;
}

/**
 * 在文本里匹配已知品牌并打分。
 *
 * 得分 = `count`（库中存量）+ 经典加成（`classicCount > 0` 时 +10）。
 * 存量大的品牌优先，是因为用户明确要「大益等知名厂商」——知名度的最好
 * 代理就是**本站库里的存量**（编辑部维护过的品牌，比外部知名度榜更贴合本站）。
 *
 * 匹配用「品牌名出现在文本中」的最朴素做法：品牌是中文专名，
 * 不存在大小写/空格变体问题；`大益` 会命中「大益茶」，`大益普洱` 也命中。
 */
export function scoreBrands(text: string, brands: readonly BrandStat[]): BrandScore {
  const matched: Array<{ brand: string; score: number; classic: boolean }> = [];
  for (const b of brands) {
    if (!b.brand || !text.includes(b.brand)) continue;
    const classic = b.classicCount > 0;
    matched.push({ brand: b.brand, score: b.count + (classic ? 10 : 0), classic });
  }
  matched.sort((a, b) => b.score - a.score || a.brand.localeCompare(b.brand));
  return {
    matched: matched.map((m) => m.brand),
    classicHits: matched.filter((m) => m.classic).map((m) => m.brand),
    score: matched.reduce((sum, m) => sum + m.score, 0),
    top: matched.length > 0 ? matched[0].brand : null,
  };
}

/** 库中经典普洱的茶品名（`isClassic`），用于喂给改写 prompt 做规范命名。 */
export function matchClassicTeas(
  text: string,
  classicTeas: readonly string[],
): string[] {
  return classicTeas.filter((name) => name && text.includes(name));
}

// ── 具象信号 ────────────────────────────────────────────────────────

/** 产区/山头词。 */
const ORIGIN_KEYWORDS: readonly string[] = [
  "冰岛", "班章", "易武", "临沧", "勐库", "景迈", "南糯", "无量山", "邦东",
  "那柯", "勐海", "澜沧", "双江", "邦弄", "帕沙", "那勐", "忙麓", "昔归",
  "景东", "镇沅", "凤庆", "勐库镇", "高山", "古树", "单株", "山头",
];

/** 批次/年份标记。 */
const BATCH_KEYWORDS: readonly string[] = [
  "批次", "第", "年制", "年生", "春茶季", "熟茶", "生茶",
];

/**
 * 统计素材的「具象信号」种类数（0–4）。
 *
 * 四类：价格数字 / 已知品牌 / 产区山头 / 批次年份。
 *
 * 「内容太泛」是编辑最常给的退回理由，而**泛**是可以量化成信号数量的：
 * 一条只说「市场回暖、品质提升」的稿子四类信号全无；一条有品牌、有产区、
 * 有价格、有批次的行情稿四类全有。数量门槛比「让模型别写空话」有效得多。
 */
export function countConcreteSignals(
  text: string,
  brands: readonly BrandStat[] = [],
): number {
  let n = 0;
  if (/[0-9０-９]+(\.[0-9]+)?\s*(元|万元|万|块|kg|公斤|片|饼|提|克|g)/i.test(text)) n++;
  if (brands.some((b) => b.brand && text.includes(b.brand))) n++;
  if (ORIGIN_KEYWORDS.some((k) => text.includes(k))) n++;
  if (BATCH_KEYWORDS.some((k) => text.includes(k))) n++;
  return n;
}

// ── 素材评估 ────────────────────────────────────────────────────────

/** 评估上下文。 */
export interface PolicyContext {
  /** 当前时间（毫秒时间戳）。 */
  now: number;
  /** 规则集。 */
  policy: FeedbackPolicy;
  /** 库中品牌统计。 */
  brands: readonly BrandStat[];
  /** 库中经典茶品名。 */
  classicTeas?: readonly string[];
}

/** 评估结果。 */
export interface MaterialEvaluation {
  ok: boolean;
  /** 拒绝原因（ok=false 时）。 */
  reason?: string;
  /** 排序分（0–100，越高越优先成稿）。 */
  score: number;
  /** 具象信号数。 */
  signals: number;
  /** 命中的品牌。 */
  brands: string[];
  /** 命中的经典茶品名。 */
  classicTeas: string[];
  /** 素材最新日期（毫秒时间戳）。 */
  latestDate: number | null;
}

/**
 * 按规则集评估一条素材。
 *
 * 检查顺序按**诊断价值**排（与 `plan.ts` 的 `isPublishable` 同一原则）：
 * 先说「为什么这个稿子不行」中最可行动的那条，再谈别的。
 *  1. 过时（最新日期超出时效窗）；
 *  2. 过季春茶（用户明确点名的当期问题）；
 *  3. 未命中已知品牌（仅当反馈攒够并开启该规则）；
 *  4. 过于笼统（具象信号不足）。
 *
 * 排序分：时效 60 分（越新越高）+ 品牌 30 分 + 具象 10 分。
 * 排序分不参与准入，只决定**同样合格的素材谁先成稿**——用户要「大益等知名
 * 厂商的经典普洱」，在候选池里排前面就是最直接的落实方式。
 */
export function evaluateMaterial(
  material: { title?: string; body?: string; publishedAt?: string },
  ctx: PolicyContext,
): MaterialEvaluation {
  const { now, policy } = ctx;
  const text = `${material.title ?? ""} ${material.body ?? ""}`;
  const latest = latestMaterialDate(material, now);
  const brands = scoreBrands(text, ctx.brands);
  const signals = countConcreteSignals(text, ctx.brands);
  const classicTeas = matchClassicTeas(text, ctx.classicTeas ?? []);

  const age = latest ? ageInDays(latest, now) : null;
  if (age !== null && age > policy.maxAgeDays) {
    return {
      ok: false,
      reason: `素材过时（最新日期 ${formatDate(latest!)}，距今 ${age} 天 > ${policy.maxAgeDays} 天）`,
      score: 0,
      signals,
      brands: brands.matched,
      classicTeas,
      latestDate: latest ? latest.getTime() : null,
    };
  }

  if (policy.rejectCrossSeason && isCrossSeasonMaterial(material, now, policy.maxAgeDays)) {
    return {
      ok: false,
      reason: `过季春茶（当前 ${new Date(now).getUTCMonth() + 1} 月，素材只讲春茶且无近期日期）`,
      score: 0,
      signals,
      brands: brands.matched,
      classicTeas,
      latestDate: latest ? latest.getTime() : null,
    };
  }

  if (policy.requireKnownBrand && brands.matched.length === 0) {
    return {
      ok: false,
      reason: "未命中库中已知品牌（反馈：非知名茶品）",
      score: 0,
      signals,
      brands: brands.matched,
      classicTeas,
      latestDate: latest ? latest.getTime() : null,
    };
  }

  if (signals < policy.minConcreteSignals) {
    return {
      ok: false,
      reason: `内容过于笼统（具象信号 ${signals} 类 < 要求的 ${policy.minConcreteSignals} 类）`,
      score: 0,
      signals,
      brands: brands.matched,
      classicTeas,
      latestDate: latest ? latest.getTime() : null,
    };
  }

  const freshness = age === null ? 30 : Math.max(0, 60 - (age / policy.maxAgeDays) * 60);
  const brandScore = Math.min(30, brands.score);
  const signalScore = Math.min(10, signals * 2.5);

  return {
    ok: true,
    score: Math.round(freshness + brandScore + signalScore),
    signals,
    brands: brands.matched,
    classicTeas,
    latestDate: latest ? latest.getTime() : null,
  };
}

/** 格式化日期为 `YYYY-MM-DD`（UTC）。 */
function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
