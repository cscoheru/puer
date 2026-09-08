import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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

  // Update tastingNoteCount on keep tea
  await prisma.tea.update({
    where: { id: keepId },
    data: {
      tastingNoteCount: { increment: tastingCount.count },
      aliases: { push: remove.name },
    },
  });

  // Delete the empty tea
  await prisma.tea.delete({ where: { id: removeId } });

  return NextResponse.json({
    success: true,
    moved: { tastingNotes: tastingCount.count, articles: articleCount.count },
  });
}
