import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/** P2-R12 经典普洱审核：设置/取消茶品的经典发布状态。
 *  经典普洱区（/forum/classics、侧栏热点茶品）仅展示 isClassic=true 的茶品；
 *  其余茶品视为「归档待审」，由管理员在此审核后发布。 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const { teaId, isClassic } = await req.json();
  if (!teaId || typeof isClassic !== "boolean") {
    return NextResponse.json({ error: "缺少参数" }, { status: 400 });
  }

  const tea = await prisma.tea.findUnique({ where: { id: teaId }, select: { id: true } });
  if (!tea) return NextResponse.json({ error: "茶品不存在" }, { status: 404 });

  await prisma.tea.update({ where: { id: teaId }, data: { isClassic } });

  return NextResponse.json({ success: true, teaId, isClassic });
}
