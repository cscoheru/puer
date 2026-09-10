import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/** P2-R12：轻量拉取某茶品的品鉴笔记列表（审核台展开用）。 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可访问" }, { status: 403 });
  }

  const { id } = await params;
  const notes = await prisma.tastingNote.findMany({
    where: { teaId: id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      summary: true,
      createdAt: true,
      images: true,
      author: { select: { username: true } },
    },
    take: 200,
  });

  return NextResponse.json({ notes });
}
