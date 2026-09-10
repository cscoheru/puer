import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/** P2-R13 品牌修正：批量修改茶品品牌（单个=长度1数组）。
 *  用于清理归档产生的脏品牌（如"大印藏"是茶名被误当品牌、
 *  "班章"是山头非品牌）。修正后自动归入正确的品牌吧。 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const { teaIds, brand } = await req.json();
  if (!Array.isArray(teaIds) || teaIds.length === 0 || typeof brand !== "string" || !brand.trim()) {
    return NextResponse.json({ error: "缺少参数（teaIds 数组 + brand）" }, { status: 400 });
  }
  const newBrand = brand.trim().slice(0, 100);

  const result = await prisma.tea.updateMany({
    where: { id: { in: teaIds } },
    data: { brand: newBrand },
  });

  return NextResponse.json({ success: true, updated: result.count, brand: newBrand });
}
