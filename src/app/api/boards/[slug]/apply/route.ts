import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const board = await prisma.board.findUnique({ where: { slug } });
  if (!board) {
    return NextResponse.json({ error: "版块不存在" }, { status: 404 });
  }

  const body = await req.json();
  const teaAge = parseInt(body.teaAge, 10);
  const reason = (body.reason || "").trim();

  if (!teaAge || teaAge < 1) {
    return NextResponse.json({ error: "请填写茶龄" }, { status: 400 });
  }
  if (!reason || reason.length < 10) {
    return NextResponse.json({ error: "请详细说明申请理由（至少10个字）" }, { status: 400 });
  }

  // Check existing application
  const existing = await prisma.boardModerator.findUnique({
    where: { boardId_userId: { boardId: board.id, userId: session.user.id } },
  });
  if (existing) {
    if (existing.status === "pending") {
      return NextResponse.json({ error: "已有待审核的申请" }, { status: 400 });
    }
    if (existing.status === "approved") {
      return NextResponse.json({ error: "你已经是版主了" }, { status: 400 });
    }
    // Rejected: allow re-apply by deleting old record
    await prisma.boardModerator.delete({ where: { id: existing.id } });
  }

  const application = await prisma.boardModerator.create({
    data: {
      boardId: board.id,
      userId: session.user.id,
      teaAge,
      reason,
      status: "pending",
    },
  });

  return NextResponse.json(application, { status: 201 });
}
