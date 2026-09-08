import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const board = await prisma.board.findUnique({ where: { slug } });
  if (!board) return NextResponse.json({ error: "版块不存在" }, { status: 404 });

  // Only moderators (not deputies) can view pending deletions
  const moderator = await prisma.boardModerator.findUnique({
    where: { boardId_userId: { boardId: board.id, userId: session.user.id } },
  });
  const isAdmin = session.user.role === "admin";
  if (!isAdmin && (!moderator || moderator.status !== "approved" || moderator.role !== "moderator")) {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  const pending = await prisma.moderateAction.findMany({
    where: { boardId: board.id, status: "pending" },
    include: {
      article: { select: { id: true, title: true } },
      board: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(pending);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const board = await prisma.board.findUnique({ where: { slug } });
  if (!board) return NextResponse.json({ error: "版块不存在" }, { status: 404 });

  const moderator = await prisma.boardModerator.findUnique({
    where: { boardId_userId: { boardId: board.id, userId: session.user.id } },
  });
  const isAdmin = session.user.role === "admin";
  if (!isAdmin && (!moderator || moderator.status !== "approved" || moderator.role !== "moderator")) {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  const body = await req.json();
  const { actionId, action } = body; // action: "approve" | "reject"

  const record = await prisma.moderateAction.findUnique({ where: { id: actionId } });
  if (!record || record.status !== "pending") {
    return NextResponse.json({ error: "请求不存在或已处理" }, { status: 404 });
  }

  if (action === "approve") {
    await prisma.article.update({ where: { id: record.articleId }, data: { status: "archived" } });
    await prisma.moderateAction.update({
      where: { id: actionId },
      data: { status: "approved", approvedBy: session.user.id, resolvedAt: new Date() },
    });
  } else {
    await prisma.moderateAction.update({
      where: { id: actionId },
      data: { status: "rejected", approvedBy: session.user.id, resolvedAt: new Date() },
    });
  }

  return NextResponse.json({ success: true });
}
