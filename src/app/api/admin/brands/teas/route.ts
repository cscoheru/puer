import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/** P2-R14 品牌的茶品归属管理：
 *  - POST {brandId, addTeaIds[]}   把搜索到的茶品划入该品牌（一茶一品牌，原归属被替换）
 *  - POST {brandId, removeTeaIds[]} 移出该品牌（茶品品牌置为「未知」） */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const { brandId, addTeaIds, removeTeaIds } = await req.json();
  if (!brandId || (!Array.isArray(addTeaIds) && !Array.isArray(removeTeaIds))) {
    return NextResponse.json({ error: "缺少参数" }, { status: 400 });
  }
  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!brand) return NextResponse.json({ error: "品牌不存在" }, { status: 404 });

  const ops = [];
  if (Array.isArray(addTeaIds) && addTeaIds.length > 0) {
    ops.push(prisma.tea.updateMany({ where: { id: { in: addTeaIds } }, data: { brand: brand.name } }));
  }
  if (Array.isArray(removeTeaIds) && removeTeaIds.length > 0) {
    // 移出 → 未知（品牌唯一对应，不允许空品牌）；「未知」品牌行按需补建，保证品牌实体完整性
    const unknown = await prisma.brand.findUnique({ where: { name: "未知" } });
    if (!unknown) ops.push(prisma.brand.create({ data: { name: "未知" } }));
    ops.push(prisma.tea.updateMany({ where: { id: { in: removeTeaIds } }, data: { brand: "未知" } }));
  }

  const results = await prisma.$transaction(ops) as Array<{ count: number }>;
  const updated = results.reduce((s, r) => s + (r?.count || 0), 0);
  return NextResponse.json({ success: true, updated });
}
