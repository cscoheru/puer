import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/permissions";

/** P2-R12 经典普洱审核：设置/取消茶品的经典发布状态。
 *  经典普洱区（/forum/classics、侧栏热点茶品）仅展示 isClassic=true 的茶品；
 *  其余茶品视为「归档待审」，由管理员在此审核后发布。 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || !can(session.user, "admin:content")) {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const { teaId, isClassic } = await req.json();
  if (!teaId || typeof isClassic !== "boolean") {
    return NextResponse.json({ error: "缺少参数" }, { status: 400 });
  }

  const tea = await prisma.tea.findUnique({ where: { id: teaId }, select: { id: true } });
  if (!tea) return NextResponse.json({ error: "茶品不存在" }, { status: 404 });

  // 提升为经典 = 站长认可了这条茶 → 同时清掉「待整理」标记，
  // 它就正式进入公开的「经典」层。
  // 取消经典**不动** needsReview —— 「还没整理好」与「不是经典」是两件事。
  await prisma.tea.update({
    where: { id: teaId },
    data: isClassic ? { isClassic: true, needsReview: false } : { isClassic: false },
  });

  return NextResponse.json({ success: true, teaId, isClassic });
}
