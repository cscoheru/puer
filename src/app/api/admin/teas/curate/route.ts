import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/permissions";

/**
 * POST /api/admin/teas/curate —— 把茶品移进/移出「待整理」层。
 *
 * body: `{ teaId, needsReview: boolean }`
 *   - `needsReview: false` → 整理好了，进入公开的「普通」层
 *   - `needsReview: true`  → 退回待整理（公开可见的茶品会从公开视野消失，
 *     所以这个方向要慎用）
 *
 * 「提升为经典」不在这里 —— 那是 `/api/admin/teas/classic`，
 * 它会顺带把 `needsReview` 清掉（经典 = 站长已经认可了这条茶）。
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || !can(session.user, "admin:content")) {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const { teaId, needsReview } = await req.json();
  if (!teaId || typeof needsReview !== "boolean") {
    return NextResponse.json(
      { error: "缺少参数（teaId + needsReview）" },
      { status: 400 },
    );
  }

  const tea = await prisma.tea.findUnique({
    where: { id: teaId },
    select: { id: true, isClassic: true },
  });
  if (!tea) {
    return NextResponse.json({ error: "茶品不存在" }, { status: 404 });
  }
  // 经典茶品是公开的，不能退回「待整理」—— 那会让它从公开视野里消失。
  // 要下架请走「取消经典」。
  if (needsReview && tea.isClassic) {
    return NextResponse.json(
      { error: "经典茶品不能退回待整理（要下架请用「取消经典」）" },
      { status: 400 },
    );
  }

  await prisma.tea.update({ where: { id: teaId }, data: { needsReview } });
  return NextResponse.json({ success: true, teaId, needsReview });
}
