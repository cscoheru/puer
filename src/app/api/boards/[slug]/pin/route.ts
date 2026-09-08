import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session?.user || (session.user.role !== "admin" && session.user.level < 3)) {
    return NextResponse.json({ error: "仅管理员或 Lv.3 以上可管理置顶" }, { status: 403 });
  }

  const { slug } = await params;
  const board = await prisma.board.findUnique({ where: { slug } });
  if (!board) {
    return NextResponse.json({ error: "版块不存在" }, { status: 404 });
  }

  const { articleId } = await req.json();
  const article = await prisma.article.findUnique({ where: { id: articleId } });
  if (!article || article.boardId !== board.id) {
    return NextResponse.json({ error: "帖子不存在或不属于该版块" }, { status: 404 });
  }

  const updated = await prisma.article.update({
    where: { id: articleId },
    data: { isPinned: !article.isPinned },
  });

  return NextResponse.json({ isPinned: updated.isPinned });
}
