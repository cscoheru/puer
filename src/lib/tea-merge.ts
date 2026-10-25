/**
 * 茶品合并（同名 / 批量）。
 *
 * ## 为什么单独一个文件
 *
 * 合并的**方向**与**副作用**必须只有一份实现：单对合并的接口与
 * 「一键合并所有同名茶」的批量接口共用它（AGENTS.md 的「数据双轨」）。
 *
 * ## 方向由**服务器**决定
 *
 * 「笔记多的是主体」这条规则写在这里，不在界面上 —— 界面上点错了方向，
 * 就会把内容多的一方删掉（笔记会跟着级联删）。客户端只负责说「这两条
 * 合并」，哪条留下由服务器算。
 *
 * ## 什么样的两条可以自动合并
 *
 * **名称 + 年份 + 品牌三者全同**。只比名称会出事：生产库里有一组叫
 * 「我所了解的大益茶」的三条，年份分别是 0 / 2000 / 2000，品牌也不同 ——
 * 那不是同一款茶，合并掉就丢了。
 */
import { prisma } from "@/lib/prisma";
import { recomputeTeaStats } from "@/lib/tea-stats";
import { pickMergeDirection } from "@/lib/tea-merge-rules";

export { groupSameNameTeas, pickMergeDirection } from "@/lib/tea-merge-rules";

export interface MergeResult {
  keepId: string;
  keepName: string;
  removedId: string;
  removedName: string;
  /** 转移过去的引用数（笔记 + 帖子 + 茶仓条目）。 */
  movedRefs: number;
}

/**
 * 把 `dropId` 并入 `keepId`：转移笔记/帖子/茶仓条目，把被并掉的名字写进
 * 别名，然后删掉被并的那一行。
 *
 * 全程一个事务：要么都成，要么都不成（不会出现「笔记搬走了、茶还在」的
 * 中间态）。
 */
export async function mergeTeaPair(
  keepId: string,
  dropId: string,
): Promise<MergeResult> {
  if (keepId === dropId) {
    throw new Error("不能自己合并自己");
  }

  const [a, b] = await Promise.all([
    prisma.tea.findUnique({
      where: { id: keepId },
      select: {
        id: true,
        name: true,
        isClassic: true,
        _count: { select: { tastingNotes: true, articles: true, cellarItems: true } },
      },
    }),
    prisma.tea.findUnique({
      where: { id: dropId },
      select: {
        id: true,
        name: true,
        isClassic: true,
        _count: { select: { tastingNotes: true, articles: true, cellarItems: true } },
      },
    }),
  ]);
  if (!a || !b) {
    throw new Error("茶品不存在");
  }

  const refsOf = (t: {
    _count: { tastingNotes: number; articles: number; cellarItems: number };
  }) => t._count.tastingNotes + t._count.articles + t._count.cellarItems;

  const { keep, drop } = pickMergeDirection(
    { id: a.id, name: a.name, isClassic: a.isClassic, refs: refsOf(a) },
    { id: b.id, name: b.name, isClassic: b.isClassic, refs: refsOf(b) },
  );

  const keepRow = await prisma.tea.findUnique({
    where: { id: keep.id },
    select: { aliases: true },
  });
  const existingAliases = new Set<string>(keepRow?.aliases ?? []);
  const newAliases = [drop.name, ...(keepRow?.aliases ?? [])].filter(
    (n) => !existingAliases.has(n),
  );

  const movedRefs = keep.id === a.id ? refsOf(b) : refsOf(a);

  await prisma.$transaction([
    prisma.tastingNote.updateMany({
      where: { teaId: drop.id },
      data: { teaId: keep.id },
    }),
    prisma.article.updateMany({
      where: { teaId: drop.id },
      data: { teaId: keep.id },
    }),
    prisma.cellarItem.updateMany({
      where: { teaId: drop.id },
      data: { teaId: keep.id },
    }),
    prisma.tea.update({
      where: { id: keep.id },
      data: newAliases.length > 0 ? { aliases: { push: newAliases } } : {},
    }),
    prisma.tea.delete({ where: { id: drop.id } }),
  ]);

  await recomputeTeaStats(keep.id);

  return {
    keepId: keep.id,
    keepName: keep.name,
    removedId: drop.id,
    removedName: drop.name,
    movedRefs,
  };
}
