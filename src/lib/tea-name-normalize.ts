/**
 * 茶品名的**归一化** —— 判断「两条记录是不是同一款茶」的一条依据。
 *
 * ## 为什么需要它
 *
 * 导入去重以「年份 + 批次」为门槛（`scripts/import_tasting_notes.py` 的
 * `find_exact_match`）：**年份解析不出来就完全不去重**。于是
 * 「国饮-2015班章大树」「普洱自在饮：2019-01茶友盲品」「国饮-2015」这类
 * 重复条目都进来了。归一化给「年份解析不出来」时补一条兜底的路：
 * 名字去掉修饰之后一样，就算同一条。
 *
 * ## 规则（与 Python 那份**逐条对应**）
 *
 *   1. NFKC 规范化（全角 → 半角，兼容字符分解）
 *   2. 去空白与分隔符
 *   3. 英文小写
 *
 * ⚠️ **括号里的内容要留着** ——「2019 冰岛（生）」与「2019 冰岛（熟）」
 * 归一化后如果都变成「2019冰岛」，两条不同的茶就被当成同一条了。
 *
 * ## ⚠️ 与 Python 那份必须一致
 *
 * `scripts/import_tasting_notes.py` 的 `normalize()` 是同一套规则，但它是
 * Python、跑不了 TS —— 只能各写一份。**改这里要同步改那个脚本**
 * （两处都注明了这件事）。`src/lib/tea-name-normalize.test.ts` 用同一批
 * 例子钉住 TS 这份的行为。
 */

/** 去掉的空白与分隔符（与 Python 的 `normalize()` 同一个集合）。 */
const SEPARATORS = /[\s\-_（）()\[\]【】「」,，.。:：·、\/]+/g;

/**
 * 茶品名的归一化形式 —— 两个名字的归一化结果相同，就当作同一款茶。
 *
 * 例：
 *   「国饮-2015」   → 「国饮2015」
 *   「国饮 2015」   → 「国饮2015」
 *   「国饮：2015」  → 「国饮2015」  ← NFKC 把全角冒号变成半角
 */
export function normalizeTeaName(name: string): string {
  if (!name) return "";
  return name.normalize("NFKC").replace(SEPARATORS, "").toLowerCase();
}

/**
 * 两个名字是不是「同一款茶」。
 *
 * 归一化后相同才算 —— 名字完全相同当然算，名字不同但归一化后相同也算
 * （「国饮-2015」与「国饮 2015」）。
 */
export function isSameTeaName(a: string, b: string): boolean {
  const na = normalizeTeaName(a);
  return na.length > 0 && na === normalizeTeaName(b);
}
