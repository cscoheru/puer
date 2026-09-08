import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  reviewNote: z.string().trim().min(1).max(4000),
});

// 管理员回复人工鉴定意见(一次性定稿;如需修改直接重 PATCH 覆盖)
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAdmin();
  if (error) return error;
  const { id } = await params;

  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "鉴定意见不能为空" }, { status: 400 });
  }

  const review = await prisma.teaReview.update({
    where: { id },
    data: { reviewNote: body.reviewNote, status: "reviewed", reviewedAt: new Date() },
    select: { id: true, status: true, reviewedAt: true },
  }).catch(() => null);
  if (!review) {
    return NextResponse.json({ error: "鉴定单不存在" }, { status: 404 });
  }
  return NextResponse.json({ review });
}
