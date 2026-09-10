import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recomputeTeaStats } from "@/lib/tea-stats";

/** P2-R12 品鉴笔记「降级合并」：把某条笔记从当前茶品移动到另一茶品，
 *  作为目标茶品的一条品鉴日记。用于修正归档时合并不准确的情况。 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const { noteId, targetTeaId } = await req.json();
  if (!noteId || !targetTeaId) {
    return NextResponse.json({ error: "缺少参数" }, { status: 400 });
  }

  const note = await prisma.tastingNote.findUnique({ where: { id: noteId }, select: { id: true, teaId: true } });
  if (!note) return NextResponse.json({ error: "笔记不存在" }, { status: 404 });
  if (note.teaId === targetTeaId) {
    return NextResponse.json({ error: "笔记已属于该茶品" }, { status: 400 });
  }

  await prisma.tastingNote.update({ where: { id: noteId }, data: { teaId: targetTeaId } });

  // 双方茶品的计数与评分重算
  await recomputeTeaStats(note.teaId);
  await recomputeTeaStats(targetTeaId);

  return NextResponse.json({ success: true, noteId, targetTeaId });
}
