import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * P2-R5 经典普洱跟进帖「升级为正式帖」：
 * toggle articles.promotedHomeAt —— 非空 = 进入主 feed（首页），NULL = 仅在
 * 茶品档案/经典普洱区内可见。权限：帖子作者、管理员或 Lv.3+（比 pin 宽，
 * 作者可自行决定把自己的跟进帖推上首页）。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { slug } = await params;
  const board = await prisma.board.findUnique({ where: { slug } });
  if (!board) {
    return NextResponse.json({ error: "版块不存在" }, { status: 404 });
  }

  const { articleId } = await req.json();
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { id: true, authorId: true, boardId: true, teaId: true },
  });
  if (!article || article.boardId !== board.id) {
    return NextResponse.json({ error: "帖子不存在或不属于该版块" }, { status: 404 });
  }
  if (!article.teaId) {
    return NextResponse.json({ error: "仅跟进帖支持升级" }, { status: 400 });
  }

  const isAuthor = session.user.id === article.authorId;
  const canPromote =
    session.user.role === "admin" || session.user.level >= 3 || isAuthor;
  if (!canPromote) {
    return NextResponse.json({ error: "仅作者、管理员或 Lv.3 以上可升级" }, { status: 403 });
  }

  const current = await prisma.article.findUnique({
    where: { id: articleId },
    select: { promotedHomeAt: true },
  });
  const updated = await prisma.article.update({
    where: { id: articleId },
    data: current?.promotedHomeAt
      ? { promotedHomeAt: null }
      : { promotedHomeAt: new Date() },
  });

  return NextResponse.json({
    isPromoted: !!updated.promotedHomeAt,
    promotedHomeAt: updated.promotedHomeAt,
  });
}
