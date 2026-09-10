import { prisma } from "@/lib/prisma";

/** P2-R12：重算茶品的冗余统计（tastingNoteCount + avgRating）。
 *  笔记升降级/合并后调用，保证列表排序（tastingNoteCount desc）与
 *  详情页评分展示一致。avgRating = 该茶所有笔记五维评分非空值的总平均。 */
export async function recomputeTeaStats(teaId: string): Promise<void> {
  const notes = await prisma.tastingNote.findMany({
    where: { teaId },
    select: { appearance: true, color: true, aroma: true, taste: true, aftertaste: true },
  });
  const all: number[] = [];
  for (const n of notes) {
    for (const v of [n.appearance, n.color, n.aroma, n.taste, n.aftertaste]) {
      if (typeof v === "number") all.push(v);
    }
  }
  const avg = all.length > 0 ? all.reduce((a, b) => a + b, 0) / all.length : null;
  await prisma.tea.update({
    where: { id: teaId },
    data: { tastingNoteCount: notes.length, avgRating: avg },
  });
}
