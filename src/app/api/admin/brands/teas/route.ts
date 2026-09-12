import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/** P2-R15 品牌的茶品归属管理：
 *  - POST {brandId, addTeaIds[]}          批量划入该品牌（一茶一品牌，原归属被替换）
 *  - POST {brandId, removeTeaIds[]}       批量移出（默认置「未知」）
 *  - POST {brandId, removeTeaIds[], toBrandId} 批量移出到指定品牌
 *  - POST {brandId, deleteTeaIds[]}       P2-R21 批量软删除（移入删除箱，可还原/彻底删除） */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const { brandId, addTeaIds, removeTeaIds, toBrandId, deleteTeaIds } = await req.json();
  if (!brandId || (!Array.isArray(addTeaIds) && !Array.isArray(removeTeaIds) && !Array.isArray(deleteTeaIds))) {
    return NextResponse.json({ error: "缺少参数" }, { status: 400 });
  }
  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!brand) return NextResponse.json({ error: "品牌不存在" }, { status: 404 });

  const ops = [];
  if (Array.isArray(addTeaIds) && addTeaIds.length > 0) {
    ops.push(prisma.tea.updateMany({ where: { id: { in: addTeaIds } }, data: { brand: brand.name } }));
  }
  if (Array.isArray(removeTeaIds) && removeTeaIds.length > 0) {
    // 移出目标：指定品牌（校验存在，不允许移出到源品牌本身），默认「未知」
    let targetName = "未知";
    if (toBrandId) {
      const tb = await prisma.brand.findUnique({ where: { id: toBrandId } });
      if (!tb) return NextResponse.json({ error: "目标品牌不存在" }, { status: 400 });
      if (tb.id === brandId) return NextResponse.json({ error: "目标品牌不能是当前品牌" }, { status: 400 });
      targetName = tb.name;
    }
    const existing = await prisma.brand.findUnique({ where: { name: targetName } });
    if (!existing) ops.push(prisma.brand.create({ data: { name: targetName } }));
    ops.push(prisma.tea.updateMany({ where: { id: { in: removeTeaIds } }, data: { brand: targetName } }));
  }
  if (Array.isArray(deleteTeaIds) && deleteTeaIds.length > 0) {
    // P2-R21 软删除：只删未在删除箱中的；brand 字段保留，还原时自动回原品牌
    ops.push(
      prisma.tea.updateMany({
        where: { id: { in: deleteTeaIds }, deletedAt: null },
        data: { deletedAt: new Date(), isClassic: false },
      }),
    );
  }

  const results = await prisma.$transaction(ops) as Array<{ count: number }>;
  const updated = results.reduce((s, r) => s + (r?.count || 0), 0);
  return NextResponse.json({ success: true, updated });
}
