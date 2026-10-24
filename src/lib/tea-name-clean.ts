/**
 * 茶品名里的**来源标记前缀** —— 展示时要去掉。
 *
 * 导入的茶品名带着来源标记：「（资料）2004年班章青饼」「【天天论普】_ 95青饼7542」
 * 「【天天论普】01年明星茶集锦」。这些前缀不是茶品名的一部分，摆在一起
 * 比较时会把真正不同的名字挤成一团（都长得像「【天天论普】…」）。
 *
 * 只在**展示**时去掉 —— 库里的原名不动（那是历史，改了会对不上原始出处）。
 */

/** 来源标记前缀。 */
const PREFIX_PATTERNS: RegExp[] = [
  // 「【天天论普】_ 95青饼7542」「【天天论普】01年明星茶集锦」
  /^【天天论普】[_\s]*/,
  // 「（资料）2004年班章青饼」「(资料) …」
  /^[（(]\s*资料\s*[)）]\s*/,
];

/**
 * 去掉来源标记前缀后的名字（用于展示）。
 *
 * 全部前缀都剥掉还是空 → 退回原名（总比显示空白强）。
 */
export function cleanTeaName(name: string): string {
  let n = name.trim();
  for (const re of PREFIX_PATTERNS) n = n.replace(re, "");
  n = n.trim();
  return n || name;
}

/**
 * 茶品清单的排序：**拼音**为主、**年份**为辅。
 *
 * 名字多以年份开头（"2003-班章四星孔雀"），按拼音排时年份自然聚成一段，
 * 同一年里按拼音排 → 相同/相近的名字就挨着了（站长的合并操作要的就是这个）。
 *
 * 年份为辅是为了同一名字的不同年份排在一起（"2003-班章四星孔雀" 与
 * "2004-班章四星孔雀"）。
 */
export function sortTeasForMerge<
  T extends { name: string; year: number },
>(teas: T[]): T[] {
  return [...teas].sort((a, b) => {
    const byName = cleanTeaName(a.name).localeCompare(
      cleanTeaName(b.name),
      "zh",
    );
    if (byName !== 0) return byName;
    return (a.year || 0) - (b.year || 0);
  });
}
