import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/** P2-R21 品牌管理删除箱（茶品软删除回收站）：
 *  - GET                          列出删除箱中的茶品（含关联计数，供彻底删除前判断）
 *  - POST {action:"restore", teaIds[]}   还原（deletedAt 置空，brand 未动自动回原品牌）
 *  - POST {action:"purge",   teaIds[]}   彻底删除（物理删除；有关联内容【笔记/帖子/茶会】
 *    的茶品拒绝删除并返回明细——先在经典审核/合并工具处理内容） */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可访问" }, { status: 403 });
  }
  const teas = await prisma.tea.findMany({
    where: { deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
    select: {
      id: true,
      name: true,
      brand: true,
      year: true,
      type: true,
      deletedAt: true,
      tastingNoteCount: true,
      _count: { select: { tastingNotes: true, articles: true, teaSessions: true } },
    },
  });
  return NextResponse.json({ teas });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const { action, teaIds } = await req.json();
  if ((action !== "restore" && action !== "purge") || !Array.isArray(teaIds) || teaIds.length === 0) {
    return NextResponse.json({ error: "缺少参数（action=restore|purge + teaIds[]）" }, { status: 400 });
  }

  if (action === "restore") {
    const r = await prisma.tea.updateMany({
      where: { id: { in: teaIds }, deletedAt: { not: null } },
      data: { deletedAt: null },
    });
    return NextResponse.json({ success: true, restored: r.count });
  }

  // purge：物理删除前检查关联内容（用户笔记/帖子/茶会不可连带误删）
  const rows = await prisma.tea.findMany({
    where: { id: { in: teaIds }, deletedAt: { not: null } },
    select: {
      id: true,
      name: true,
      _count: { select: { tastingNotes: true, articles: true, teaSessions: true } },
    },
  });
  const deletable = rows.filter((r) => r._count.tastingNotes === 0 && r._count.articles === 0 && r._count.teaSessions === 0);
  const blocked = rows
    .filter((r) => !deletable.some((d) => d.id === r.id))
    .map((r) => ({
      name: r.name,
      tastingNotes: r._count.tastingNotes,
      articles: r._count.articles,
      teaSessions: r._count.teaSessions,
    }));

  let purged = 0;
  if (deletable.length > 0) {
    const r = await prisma.tea.deleteMany({ where: { id: { in: deletable.map((d) => d.id) } } });
    purged = r.count;
  }
  return NextResponse.json({ success: true, purged, blocked });
}
