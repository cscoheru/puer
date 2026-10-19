import { prisma } from "@/lib/prisma";

/**
 * 重算茶品的冗余统计（tastingNoteCount + avgRating）。
 * 笔记升降级/合并/镜像后调用，保证列表排序（tastingNoteCount desc）与
 * 详情页评分展示一致。avgRating = 该茶所有笔记五维评分非空值的总平均。
 *
 * **按实际条数 `set` 而不是 `increment`** —— 这是整套镜像/回填方案幂等的地基：
 * 重复跑不会越加越多，历史漂移也会被下一次调用自动修好。
 * （反例：`api/admin/teas/merge/route.ts` 曾经用 increment，是现存的漂移来源。）
 *
 * `client` 可注入，用于两处：
 *  1. 与笔记创建放进同一个事务，避免「笔记写了、计数没跟上」的中间态；
 *  2. backfill 脚本用自己 new 出来的 PrismaClient 调它，而不是 `@/lib/prisma` 单例。
 * 默认参数让现有调用点零改动。
 */
export async function recomputeTeaStats(
  teaId: string,
  client: Pick<typeof prisma, "tastingNote" | "tea"> = prisma,
): Promise<void> {
  const notes = await client.tastingNote.findMany({
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
  await client.tea.update({
    where: { id: teaId },
    data: { tastingNoteCount: notes.length, avgRating: avg },
  });
}
