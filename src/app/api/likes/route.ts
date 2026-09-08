import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { type, refId, articleId } = await req.json();
  if (!type || !refId) {
    return NextResponse.json({ error: "参数不完整" }, { status: 400 });
  }

  const existing = await prisma.like.findUnique({
    where: { userId_type_refId: { userId: session.user.id, type, refId } },
  });

  if (existing) {
    await prisma.like.delete({ where: { id: existing.id } });
    if (type === "comment" && refId) {
      await prisma.comment.update({
        where: { id: refId },
        data: { likesCount: { decrement: 1 } },
      });
    }
    return NextResponse.json({ liked: false });
  }

  await prisma.like.create({
    data: {
      userId: session.user.id,
      type,
      refId,
      articleId: type === "article" ? refId : articleId,
    },
  });

  if (type === "comment" && refId) {
    await prisma.comment.update({
      where: { id: refId },
      data: { likesCount: { increment: 1 } },
    });
  }

  return NextResponse.json({ liked: true });
}
