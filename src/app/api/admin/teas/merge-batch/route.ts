import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recomputeTeaStats } from "@/lib/tea-stats";

/** P2-R15 批量合并：多个茶品（removeIds[]）合并到保留主体（keepId）。
 *  事务：笔记/帖子全部转移到主体 → 主体 aliases 记录被合并名 → 重算主体统计 → 删除被合并茶品。 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
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
    prisma.tea.findUnique({ where: { id: keepId }, select: { id: true, aliases: true } }),
    prisma.tea.findMany({ where: { id: { in: removeIds } }, select: { id: true, name: true, isClassic: true } }),
  ]);
  if (!keep) return NextResponse.json({ error: "保留茶品不存在" }, { status: 404 });
  if (removes.length !== removeIds.length) {
    return NextResponse.json({ error: "部分被合并茶品不存在" }, { status: 404 });
  }

  const [tastingCount, articleCount] = await prisma.$transaction([
    prisma.tastingNote.updateMany({ where: { teaId: { in: removeIds } }, data: { teaId: keepId } }),
    prisma.article.updateMany({ where: { teaId: { in: removeIds } }, data: { teaId: keepId } }),
  ]);

  // 被合并茶名进主体 aliases（去重，避免重复合并时膨胀）
  const existingAliases = new Set(keep.aliases || []);
  const newAliases = removes.map((r) => r.name).filter((n) => !existingAliases.has(n));

  await prisma.$transaction([
    prisma.tea.update({
      where: { id: keepId },
      data: newAliases.length > 0 ? { aliases: { push: newAliases } } : {},
    }),
    prisma.tea.deleteMany({ where: { id: { in: removeIds } } }),
  ]);

  await recomputeTeaStats(keepId);

  return NextResponse.json({
    success: true,
    merged: removes.length,
    moved: { tastingNotes: tastingCount.count, articles: articleCount.count },
  });
}
