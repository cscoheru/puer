import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recomputeTeaStats } from "@/lib/tea-stats";
import { can } from "@/lib/permissions";

/** P2-R15 批量合并：多个茶品（removeIds[]）合并到保留主体（keepId）。
 *  事务：笔记/帖子全部转移到主体 → 主体 aliases 记录被合并名 → 重算主体统计 → 删除被合并茶品。 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || !can(session.user, "admin:content")) {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const { keepId, removeIds } = await req.json();
  if (!keepId || !Array.isArray(removeIds) || removeIds.length === 0) {
    return NextResponse.json({ error: "缺少参数（keepId + removeIds 数组）" }, { status: 400 });
  }
  if (removeIds.includes(keepId)) {
    return NextResponse.json({ error: "保留主体不能同时出现在被合并列表中" }, { status: 400 });
  }

  const [keep, removes] = await Promise.all([
    prisma.tea.findUnique({
      where: { id: keepId },
      select: { id: true, aliases: true, isClassic: true, needsReview: true },
    }),
    prisma.tea.findMany({
      where: { id: { in: removeIds } },
      select: { id: true, name: true, isClassic: true, needsReview: true },
    }),
  ]);
  if (!keep) return NextResponse.json({ error: "保留茶品不存在" }, { status: 404 });
  if (removes.length !== removeIds.length) {
    return NextResponse.json({ error: "部分被合并茶品不存在" }, { status: 404 });
  }

  const [tastingCount, articleCount, cellarCount] = await prisma.$transaction([
    prisma.tastingNote.updateMany({ where: { teaId: { in: removeIds } }, data: { teaId: keepId } }),
    prisma.article.updateMany({ where: { teaId: { in: removeIds } }, data: { teaId: keepId } }),
    // 茶仓条目也要转移！`CellarItem.teaId` 是 onDelete: SetNull ——
    // 不转移的话，被合并的茶品一删，用户的茶仓条目就**丢了茶品关联**
    // （茶仓里那条变成「自建茶品」）。
    prisma.cellarItem.updateMany({ where: { teaId: { in: removeIds } }, data: { teaId: keepId } }),
  ]);

  // 被合并茶名进主体 aliases（去重，避免重复合并时膨胀）
  const existingAliases = new Set(keep.aliases || []);
  const newAliases = removes.map((r) => r.name).filter((n) => !existingAliases.has(n));

  // 主体茶品的可见性取**被合并那批里最宽松的**：
  // 只要有一条原本是公开的，合并后主体也必须公开 —— 否则把公开茶品并进
  // 一条「待整理」的茶品，那批内容就从公开视野里消失了。
  const keepNeedsReview =
    keep.needsReview && removes.every((r) => r.needsReview);

  await prisma.$transaction([
    prisma.tea.update({
      where: { id: keepId },
      data: {
        ...(newAliases.length > 0 ? { aliases: { push: newAliases } } : {}),
        needsReview: keepNeedsReview,
      },
    }),
    prisma.tea.deleteMany({ where: { id: { in: removeIds } } }),
  ]);

  await recomputeTeaStats(keepId);

  return NextResponse.json({
    success: true,
    merged: removes.length,
    moved: {
      tastingNotes: tastingCount.count,
      articles: articleCount.count,
      cellarItems: cellarCount.count,
    },
  });
}
