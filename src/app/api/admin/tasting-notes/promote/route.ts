import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const { tastingNoteId } = await req.json();
  if (!tastingNoteId) {
    return NextResponse.json({ error: "缺少品鉴笔记 ID" }, { status: 400 });
  }

  const note = await prisma.tastingNote.findUnique({
    where: { id: tastingNoteId },
    select: { id: true, title: true, teaId: true },
  });
  if (!note) {
    return NextResponse.json({ error: "品鉴笔记不存在" }, { status: 404 });
  }

  const [newTea] = await prisma.$transaction(async (tx) => {
    // Find old tea to update its count later
    const oldTea = await tx.tea.findUnique({
      where: { id: note.teaId },
      select: { tastingNoteCount: true },
    });

    // Create new tea from tasting note title
    const tea = await tx.tea.create({
      data: {
        name: note.title.slice(0, 200),
        brand: "未知",
        year: 0,
        type: "raw",
        tastingNoteCount: 1,
        aliases: [note.title.slice(0, 200)],
        createdBy: session.user.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Move tasting note to new tea
    await tx.tastingNote.update({
      where: { id: tastingNoteId },
      data: { teaId: tea.id },
    });

    // Update old tea counter
    if (oldTea && oldTea.tastingNoteCount > 0) {
      await tx.tea.update({
        where: { id: note.teaId },
        data: { tastingNoteCount: { decrement: 1 } },
      });
    }

    return [tea];
  });

  return NextResponse.json({
    success: true,
    newTeaId: newTea.id,
    newTeaName: newTea.name,
  });
}
