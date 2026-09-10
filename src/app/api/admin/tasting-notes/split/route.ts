import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recomputeTeaStats } from "@/lib/tea-stats";

/** P2-R12 品鉴笔记「升级独立」：把某条笔记从当前茶品拆出，独立为一个
 *  新茶品（该笔记成为新茶品的首篇品鉴日记）。新茶品 isClassic=false
 *  （归档待审，需管理员在经典审核台发布后才进入经典普洱区）。 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const { noteId, name, brand, year, type } = await req.json();
  if (!noteId) return NextResponse.json({ error: "缺少参数" }, { status: 400 });

  const note = await prisma.tastingNote.findUnique({
    where: { id: noteId },
    select: { id: true, teaId: true, title: true },
  });
  if (!note) return NextResponse.json({ error: "笔记不存在" }, { status: 404 });

  const sourceTea = await prisma.tea.findUnique({
    where: { id: note.teaId },
    select: { brand: true, year: true, type: true },
  });

  // 新茶品名称：入参优先，否则用笔记标题（截 200）
  const newName = (typeof name === "string" && name.trim()) || note.title || "未命名茶品";
  const newTea = await prisma.tea.create({
    data: {
      name: newName.trim().slice(0, 200),
      brand: (typeof brand === "string" && brand.trim()) || sourceTea?.brand || "未知",
      year: Number.isInteger(year) ? year : sourceTea?.year ?? 0,
      type: type === "raw" || type === "ripe" ? type : sourceTea?.type || "raw",
      isClassic: false, // 归档待审：审核发布后才进经典普洱
      createdBy: session.user.id,
    },
  });

  await prisma.tastingNote.update({ where: { id: noteId }, data: { teaId: newTea.id } });

  await recomputeTeaStats(note.teaId);
  await recomputeTeaStats(newTea.id);

  return NextResponse.json({ success: true, noteId, newTeaId: newTea.id });
}
