/**
 * 「是不是同一款茶」的**判定规则**（纯函数，可离线单测）。
 *
 * ## 为什么抽出来
 *
 * 这套规则原来长在 `scripts/seed-tea-library.ts` 里（导入茶品时用它把清洗
 * 数据对上东和 SKU）。现在还要用它做**东和茶图回填**（给没图的茶品配图）
 * —— 两处各写一份必然漂，所以抽到这里，两边都 import。
 *
 * ## 判定「同一款」的三条依据
 *
 *   1. **核心词包含度** —— 名字长短不一时包含度比相似度准
 *      （「301咖啡大大益7592」被「2003-飞台咖啡大大益7592」完全包含 → 1.0）；
 *   2. **年份一致** —— 同一年的同一款；
 *   3. **批次不冲突** —— 「204紫大益7572」与「208紫大益7572」是同一产品线
 *      的不同批次，价格不同，不是同一款。
 */
import { normalizeTeaName } from "./tea-name-normalize.ts";

/**
 * 通用词 —— 比对时要剔除，它们不携带产品身份。
 *
 * 「普洱」「生茶」「熟茶」「饼」「沱」这些在每个名字里都可能出现；
 * 留着它们会让「2003 生茶」跟「2004 熟茶」看起来很像。
 *
 * ⚠️ **大益 / 中茶不在这个表里** —— 它们是**产品线**，去掉之后
 * 「紫大益7572」会变成「紫」、「黄印7572」变成「黄印」，
 * 两款完全不同的茶反而被判成同款。
 */
export const GENERIC_WORDS = [
  "普洱", "生茶", "熟茶", "产品", "定制", "系列", "高级", "精品", "特级",
  "印级", "唛级", "批次", "年", "饼", "沱", "砖", "散", "贡", "生", "熟",
  "茶", "号",
];

/**
 * 名字的「核心」—— 去掉数字（年份/唛号/批号/克重）、通用词与标点后剩下的。
 *
 * 这是「异名同款」比对的依据：真正的产品身份在剩下的字里
 * （「飞台咖啡大大益」与「咖啡大大益」、「中茶黄印」与「黄印」）。
 */
export function coreOf(name: string): string {
  let s = name.normalize("NFKC").toLowerCase();
  s = s.replace(/\d+/g, "");
  for (const w of GENERIC_WORDS) s = s.split(w).join("");
  // 计量单位也要剔除 —— 「357克」留下个「克」字，会造出「大益克」这种
  // 两字核心，然后任何含「大益」的名字都被判成它的同款。
  for (const w of ["公斤", "克", "提", "件", "片", "篓", "筒", "罐", "条", "盒", "g"]) {
    s = s.split(w).join("");
  }
  return s.replace(/[\s\-_（）()\[\]【】「」,，.。:：·、/]/g, "");
}

/**
 * 名字里的**唛号**（4 位数字，去掉年份本身）。
 *
 * ⚠️ 必须先去掉年份：「2002年201批次春尖茶青饼」里的 4 位数字是年份
 * 2002，不是唛号。
 */
export function maoTokens(name: string, year: number): string[] {
  return (name.normalize("NFKC").match(/\d{4}/g) ?? []).filter(
    (g) => Number(g) !== year,
  );
}

/**
 * 名字开头的**批次号**（三位数）。
 *
 * 批次是产品身份的一部分：「204紫大益7572」与「208紫大益7572」是同一
 * 产品线的**不同批次**，价格不同，不该合并。
 */
export function batchOf(name: string): string | null {
  const m = name.normalize("NFKC").match(/^(\d{3})(?!\d)/);
  return m ? m[1] : null;
}

/** 字符二元组集合。 */
export function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * 包含度：短的那个有多大比例被长的那个包含。
 *
 * 用包含度而不是相似度，是因为**同款的名字往往长短不一**
 * （「301咖啡大大益7592」vs「2003-飞台咖啡大大益7592」—— 短的那个
 * 完全被长的那个包含，包含度 1.0）。
 */
export function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / Math.min(a.size, b.size);
}

/** 「异名同款」的判定阈值。 */
export const SAME_PRODUCT_THRESHOLD = 0.8;

/**
 * 核心词至少要这么长才参与匹配。
 *
 * ⚠️ 没有这条会大面积误判：不少茶品的名字去掉通用词后**只剩品牌**
 * （「2004-大益普洱熟沱」→ 核心「大益」两字），而「大益」这个二元组
 * 在几乎每条大益的茶里都出现 —— 于是「紫大益一片叶7572」会被判成
 * 「大益普洱熟沱」的同款。核心不足 3 个字，认不出产品身份。
 */
export const MIN_CORE_CHARS = 3;

/**
 * 茶品的**匹配键**：`年份 + 去掉年份后的归一化名`。
 *
 * ⚠️ 关键：库里的茶品名**自带年份**（「2003·班章乔木生态沱」「03年班章孔雀
 * 沱」「2002-班章精品白菜」三种写法都有），清洗数据则是「年份」与「名字」
 * 分开两列。匹配时必须先把名字里的年份**摘掉**再比 —— 否则会把
 * 「2003·班章乔木生态沱」算成「2003-2003班章乔木生态沱」，永远对不上。
 */
export function teaKey(year: number, rawName: string): string {
  let n = rawName.trim();
  let m = n.match(/^((?:19|20)\d{2})\s*[·\-年._]?\s*(.*)$/);
  if (m && Number(m[1]) === year) {
    n = m[2];
  } else {
    // 两位年份：「03年班章孔雀沱」
    m = n.match(/^(\d{2})年\s*(.*)$/);
    if (m && 2000 + Number(m[1]) === year) n = m[2];
  }
  return `${year}-${normalizeTeaName(n)}`;
}
