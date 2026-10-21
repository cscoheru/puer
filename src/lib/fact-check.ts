/**
 * F0 审核辅助：从草稿正文里抽出**需要人工逐项核对**的事实性陈述。
 *
 * PRD v0.3 §7 F0：「价格、年份、产地、仓储等事实性陈述需逐项勾选核对」。
 *
 * 这不是校验器 —— 机器无法判断「2017 年的勐海熟茶该值多少钱」。它做的是
 * **把散落在正文里的事实句挑出来摆到审核者面前**，让人逐条打勾/打叉。
 * 挑得不准（漏挑）比挑得多更危险，所以规则保守：宁可少挑几条明显的事实句，
 * 也不要为了召回率把整段散文都变成勾选项。
 *
 * 判定依据刻意只用「句子里出现了什么类型的量词」，不用语义模型：
 *  - 金额：带「元/万/块/¥」的数字
 *  - 年份：四位年份（2000–2099），或「XX年」
 *  - 产地：命中一份茶产区名（云南/西双版纳/勐海/易武/临沧/普洱/景谷/…）
 *  - 仓储：命中「干仓/湿仓/自然仓/港仓/仓储/仓/陈化/转化/退仓」
 *  - 批次：命中「XX批/批次/号」
 *
 * 纯函数、零依赖，可单测。
 */

/** 一条待核对的事实。 */
export interface FactCheckItem {
  /** 稳定 id（用于前端当 key 与「已核对」状态的载体）。 */
  id: string;
  /** 事实类别。 */
  kind: FactKind;
  /** 命中的那一句（HTML 已剥离）。 */
  sentence: string;
  /** 句中命中的关键片段（如「2017」「8600 元/提」）。 */
  matched: string;
}

export type FactKind = "price" | "year" | "origin" | "storage" | "batch";

export const FACT_KIND_LABELS: Record<FactKind, string> = {
  price: "价格",
  year: "年份",
  origin: "产地",
  storage: "仓储",
  batch: "批次",
};

// 茶产区关键词。命中即认为该句在陈述产地。
const ORIGIN_KEYWORDS = [
  "西双版纳", "勐海", "易武", "临沧", "普洱", "景谷", "景东", "邦东",
  "无量山", "哀牢山", "南涧", "凤庆", "双江", "勐库", "永德", "镇沅",
  "漾濞", "南糯山", "布朗山", "勐仑", "帕沙", "贺开", "班章", "老班章",
  "易武正山", "麻粟", "刮风寨", "落水洞", "牛栏坑", "弯弓", "同庆",
];

// 仓储相关词。命中即认为该句在陈述仓储条件。
const STORAGE_KEYWORDS = [
  "干仓", "湿仓", "自然仓", "港仓", "标准仓", "仓储", "仓存", "退仓",
  "陈化", "转化", "年份转化", "仓储条件", "入仓", "出仓", "干仓高香",
];

const PRICE_RE = /([0-9][0-9,，]*(?:\.[0-9]+)?)\s*(万元|万|元|块|圆|¥|￥)/g;
const YEAR_RE = /(19[0-9]{2}|20[0-9]{2})\s*年?/g;
// 批次两种语序都要认：「812 批」与「批次为 812」/「812批次」。
const BATCH_RE = /([0-9]{1,4})\s*批(?:次)?|批(?:次)?(?:为|是)?\s*([0-9]{1,4})/g;

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 按中文/英文句末标点切句。
 *
 * 段级长度上限：叙述性长段（没有句号的一大段）整段跳过 —— 否则切出来的
 * 「碎片句」仍会被当成事实陈述，把勾选项列表灌满。
 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n+/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length > 160) continue; // 整段过长 → 叙述，跳过
    for (const s of p.split(/(?<=[。！？!?；;])/)) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function firstMatch(text: string, re: RegExp): string | null {
  re.lastIndex = 0;
  const m = re.exec(text);
  if (!m) return null;
  // BATCH_RE 有两个捕获组（数字在前 / 数字在后），取非空的那个作为命中片段。
  const hit = m.slice(1).find((g) => g) ?? m[0];
  return hit.trim();
}

function hasKeyword(text: string, keywords: readonly string[]): string | null {
  for (const k of keywords) {
    if (text.includes(k)) return k;
  }
  return null;
}

/**
 * 从草稿正文抽取待核对事实。
 *
 * @param html 草稿正文（HTML）
 * @param max 最多返回多少条 —— 审核面板空间有限，且条目太多会让人放弃勾选。
 */
export function extractFactChecks(html: string, max = 20): FactCheckItem[] {
  if (typeof html !== "string" || !html) return [];
  const text = stripHtml(html);
  if (!text) return [];

  const out: FactCheckItem[] = [];
  const seen = new Set<string>();

  for (const sentence of splitSentences(text)) {
    const price = firstMatch(sentence, PRICE_RE);
    const year = firstMatch(sentence, YEAR_RE);
    const origin = hasKeyword(sentence, ORIGIN_KEYWORDS);
    const storage = hasKeyword(sentence, STORAGE_KEYWORDS);
    const batch = firstMatch(sentence, BATCH_RE);

    const kinds: Array<[FactKind, string | null]> = [
      ["price", price],
      ["year", year],
      ["origin", origin],
      ["storage", storage],
      ["batch", batch],
    ];

    for (const [kind, matched] of kinds) {
      if (!matched) continue;
      // 同一句同一类只取一次；不同类别的同一句要分别列（一句里可能同时说年份和价格）。
      const key = `${kind}:${sentence.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `${kind}-${out.length}-${matched.replace(/\s+/g, "")}`,
        kind,
        sentence: sentence.length > 120 ? sentence.slice(0, 120) + "…" : sentence,
        matched,
      });
    }
  }

  // 价格与年份是 F0 点名要核对的，排前面。
  const order: FactKind[] = ["price", "year", "origin", "storage", "batch"];
  out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return out.slice(0, max);
}

/**
 * 核对进度是否满足「逐项勾选」的要求。
 *
 * F0 的原话是「需逐项勾选核对」——所以是**全勾**才通过；只要有一条没核对
 * 就不算核对完。空列表（没有可核对项）视为通过。
 */
export function isFactCheckComplete(
  items: readonly FactCheckItem[],
  checked: ReadonlySet<string>,
): boolean {
  return items.every((it) => checked.has(it.id));
}
