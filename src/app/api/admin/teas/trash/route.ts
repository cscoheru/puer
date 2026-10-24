import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/permissions";
import { cleanTeaName } from "@/lib/tea-name-clean";

export const dynamic = "force-dynamic";

/**
 * 茶品的**回收站**（`deletedAt` 非空的那批）。
 *
 * 「软删除」= 从公开库隐藏，但行还在、笔记还在 —— 误删了能捞回来。
 * 「彻底删除」= 真的删行，**笔记会跟着级联删掉**（TastingNote.teaId 是
 * onDelete: Cascade）—— 所以有内容的茶品**不许**彻底删除，必须先合并走。
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || !can(session.user, "admin:content")) {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const teas = await prisma.tea.findMany({
    where: { deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
    select: {
      id: true,
      name: true,
      brand: true,
      year: true,
      deletedAt: true,
      _count: { select: { tastingNotes: true, articles: true, cellarItems: true } },
    },
  });

  return NextResponse.json({
    teas: teas.map((t) => ({
      id: t.id,
      name: t.name,
      displayName: cleanTeaName(t.name),
      brand: t.brand,
      year: t.year,
      deletedAt: t.deletedAt?.toISOString() ?? null,
      refs: t._count.tastingNotes + t._count.articles + t._count.cellarItems,
      tastingNotes: t._count.tastingNotes,
      articles: t._count.articles,
      cellarItems: t._count.cellarItems,
    })),
  });
}

/**
 * POST —— 恢复，或移进回收站。
 *
 * body: `{ teaId, action?: "restore" | "trash" }`（默认 restore）
 *   - `restore` → 从回收站恢复（`deletedAt` 清空）
 *   - `trash`   → 移进回收站（软删除：行还在、笔记还在，误删了能捞回来）
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || !can(session.user, "admin:content")) {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const { teaId, action } = await req.json();
  if (!teaId) {
    return NextResponse.json({ error: "缺少参数（teaId）" }, { status: 400 });
  }

  const tea = await prisma.tea.findUnique({
    where: { id: teaId },
    select: { id: true, deletedAt: true },
  });
  if (!tea) {
    return NextResponse.json({ error: "茶品不存在" }, { status: 404 });
  }

  if (action === "trash") {
    // 软删除：行还在、笔记还在，误删了能从回收站捞回来。
    if (tea.deletedAt) {
      return NextResponse.json({ error: "这条茶品已经在回收站里了" }, { status: 400 });
    }
    await prisma.tea.update({
      where: { id: teaId },
      data: { deletedAt: new Date() },
    });
    return NextResponse.json({ success: true, teaId, trashed: true });
  }

  if (!tea.deletedAt) {
    return NextResponse.json({ error: "这条茶品不在回收站里" }, { status: 400 });
  }

  await prisma.tea.update({
    where: { id: teaId },
    data: { deletedAt: null },
  });
  return NextResponse.json({ success: true, teaId, restored: true });
}

/** DELETE —— 彻底删除。 */
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user || !can(session.user, "admin:content")) {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const { teaId } = await req.json();
  if (!teaId) {
    return NextResponse.json({ error: "缺少参数（teaId）" }, { status: 400 });
  }

  const tea = await prisma.tea.findUnique({
    where: { id: teaId },
    select: {
      id: true,
      name: true,
      _count: { select: { tastingNotes: true, articles: true, cellarItems: true } },
    },
  });
  if (!tea) {
    return NextResponse.json({ error: "茶品不存在" }, { status: 404 });
  }

  const refs =
    tea._count.tastingNotes + tea._count.articles + tea._count.cellarItems;
  if (refs > 0) {
    // 彻底删除会级联删掉品鉴笔记 —— 有内容就不许删，先合并走。
    return NextResponse.json(
      {
        error: `这条茶品还挂着 ${tea._count.tastingNotes} 篇笔记、${tea._count.articles} 个帖子、${tea._count.cellarItems} 个茶仓条目，彻底删除会把它们一起删掉。请先合并到别的茶品上。`,
      },
      { status: 400 },
    );
  }

  await prisma.tea.delete({ where: { id: teaId } });
  return NextResponse.json({ success: true, teaId, name: tea.name });
}
