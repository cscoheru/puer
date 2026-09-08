import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteProps {
  params: Promise<{ id: string }>;
}

export async function PUT(req: NextRequest, { params }: RouteProps) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const comment = await prisma.comment.findUnique({ where: { id } });
  if (!comment) {
    return NextResponse.json({ error: "评论不存在" }, { status: 404 });
  }
  if (comment.authorId !== session.user.id) {
    return NextResponse.json({ error: "只能编辑自己的评论" }, { status: 403 });
  }

  const body = await req.json();
  const { content, images } = body;

  if (!content?.trim()) {
    return NextResponse.json({ error: "内容不能为空" }, { status: 400 });
  }

  const updated = await prisma.comment.update({
    where: { id },
    data: {
      content: content.trim(),
      ...(images !== undefined ? { images } : {}),
    },
    include: {
      author: { select: { id: true, username: true, avatar: true, level: true } },
    },
  });

  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: RouteProps) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const comment = await prisma.comment.findUnique({ where: { id } });
  if (!comment) {
    return NextResponse.json({ error: "评论不存在" }, { status: 404 });
  }
  if (comment.authorId !== session.user.id && session.user.level < 3) {
    return NextResponse.json({ error: "无权限删除" }, { status: 403 });
  }

  await prisma.comment.delete({ where: { id } });

  // Decrement article reply count
  if (comment.articleId) {
    await prisma.article.update({
      where: { id: comment.articleId },
      data: { replyCount: { decrement: 1 } },
    }).catch(() => {});
  }

  return NextResponse.json({ success: true });
}
