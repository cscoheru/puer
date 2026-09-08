import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 待审/全部鉴定单列表(管理后台)
export async function GET(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  const status = req.nextUrl.searchParams.get("status") ?? "pending";
  const reviews = await prisma.teaReview.findMany({
    where: status === "all" ? {} : { status },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      question: true,
      imageUrls: true,
      source: true,
      aiVerdict: true,
      aiConfidence: true,
      aiSkuName: true,
      aiAnswer: true,
      status: true,
      reviewNote: true,
      createdAt: true,
      reviewedAt: true,
      user: { select: { username: true, nickname: true } },
    },
  });
  return NextResponse.json({ reviews });
}
