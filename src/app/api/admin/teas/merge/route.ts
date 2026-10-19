import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recomputeTeaStats } from "@/lib/tea-stats";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const { keepId, removeId } = await req.json();
  if (!keepId || !removeId) {
    return NextResponse.json({ error: "缺少参数" }, { status: 400 });
  }

  const [keep, remove] = await Promise.all([
    prisma.tea.findUnique({ where: { id: keepId } }),
    prisma.tea.findUnique({ where: { id: removeId } }),
  ]);
  if (!keep || !remove) {
    return NextResponse.json({ error: "茶品不存在" }, { status: 404 });
  }

  // Merge: move all tasting notes and articles from remove to keep
  // （镜像笔记（source="article"）也在这批里被一并改挂 —— 必须在删源茶品**之前**，
  //   否则 TastingNote.teaId 的 onDelete: Cascade 会连笔记一起删掉，而帖子只被置空存活。）
  const [tastingCount, articleCount] = await prisma.$transaction([
    prisma.tastingNote.updateMany({
      where: { teaId: removeId },
      data: { teaId: keepId },
    }),
    prisma.article.updateMany({
      where: { teaId: removeId },
      data: { teaId: keepId },
    }),
  ]);

  // 别名保留 + 统计**重算**而不是 increment。
  // increment 会重复计数（笔记已经移过来了，再 +N 就是加了两遍），
  // 而 recomputeTeaStats 按实际条数 set，天然幂等 —— 镜像笔记/回填方案依赖这条不变量。
  await prisma.tea.update({
    where: { id: keepId },
    data: { aliases: { push: remove.name } },
  });
  await recomputeTeaStats(keepId);

  // Delete the empty tea
  await prisma.tea.delete({ where: { id: removeId } });

  return NextResponse.json({
    success: true,
    moved: { tastingNotes: tastingCount.count, articles: articleCount.count },
  });
}
