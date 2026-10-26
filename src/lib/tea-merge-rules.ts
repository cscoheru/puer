/**
 * 茶品合并的**纯规则**（不碰数据库，可离线单测）。
 *
 * 与 `src/lib/tea-merge.ts`（数据层）分开：那个文件 import Prisma，
 * 裸 `node --test` 解析不了。
 */

/** 合并方向比较用的一条茶（引用数 = 笔记 + 帖子 + 茶仓条目）。 */
export interface MergeCandidate {
  id: string;
  name: string;
  isClassic: boolean;
  /** 引用数（笔记 + 帖子 + 茶仓条目）。 */
  refs: number;
}

/**
 * 挑出「留谁、合并谁」。
 *
 * 规则（按顺序）：
 *   1. **经典优先** —— 经典是站长亲自选的，不能被合并掉；
 *   2. 引用多的留、少的并入。
 *
 * 规则写在这里而不在界面上：界面上点错了方向，就会把内容多的一方删掉
 * （笔记会跟着级联删）。
 */
export function pickMergeDirection(
  a: MergeCandidate,
  b: MergeCandidate,
): { keep: MergeCandidate; drop: MergeCandidate } {
  if (b.isClassic && !a.isClassic) return { keep: b, drop: a };
  if (a.isClassic && !b.isClassic) return { keep: a, drop: b };
  return b.refs > a.refs ? { keep: b, drop: a } : { keep: a, drop: b };
}

/**
 * 合并时**封面与图集怎么算**。
 *
 * 2026-10-26 站长报「经典普洱的封面被换成东和的图了」→ 自查发现：合并只搬了
 * 笔记/帖子/茶仓条目与**名字**，**没搬封面** —— 被并掉的那行如果带着站长的
 * 茶图，那张图就跟着那一行一起没了（32 张站长的茶图至今躺在 uploads/tea/ 里
 * 没人引用），茶品只好用东和图顶上。
 *
 * 规则：**保留的那条自己没有封面时**，才用被并那条的（它自己的封面更权威）。
 */
export function pickCover(
  keep: { coverImage: string | null; gallery: unknown },
  drop: { coverImage: string | null; gallery: unknown },
): { coverImage?: string | null; gallery?: string[] } {
  const out: { coverImage?: string | null; gallery?: string[] } = {};
  if (!keep.coverImage && drop.coverImage) {
    out.coverImage = drop.coverImage;
  }
  const keepGallery = Array.isArray(keep.gallery)
    ? keep.gallery.filter((x): x is string => typeof x === "string")
    : [];
  const dropGallery = Array.isArray(drop.gallery)
    ? drop.gallery.filter((x): x is string => typeof x === "string")
    : [];
  if (keepGallery.length === 0 && dropGallery.length > 0) {
    out.gallery = dropGallery;
  }
  return out;
}

/** 一组「同名同年份同品牌」的茶。 */
export interface SameNameGroup {
  name: string;
  year: number;
  brand: string;
  ids: string[];
}

/**
 * 找出所有「名称 + 年份 + 品牌」完全相同的茶品分组。
 *
 * 只看名称会误伤：生产库里有一组三条都叫「我所了解的大益茶」，年份是
 * 0 / 2000 / 2000，品牌也不同 —— 那不是同一款茶，合并掉就丢了。
 * 名字里那些来源前缀（「（资料）」「【天天论普】」）先剥掉再比 ——
 * 那是同一个意思的两种写法。
 */
export function groupSameNameTeas(
  teas: { id: string; name: string; year: number; brand: string }[],
  cleanName: (name: string) => string,
): SameNameGroup[] {
  const groups = new Map<string, SameNameGroup>();
  for (const t of teas) {
    const key = `${cleanName(t.name)}|${t.year}|${t.brand}`;
    const g = groups.get(key);
    if (g) g.ids.push(t.id);
    else
      groups.set(key, {
        name: t.name,
        year: t.year,
        brand: t.brand,
        ids: [t.id],
      });
  }
  return [...groups.values()].filter((g) => g.ids.length > 1);
}
