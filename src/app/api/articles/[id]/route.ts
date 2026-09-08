import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { screenContent } from "@/lib/moderation";
import { canViewArticleDetail } from "@/lib/article-visibility";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const article = await prisma.article.findUnique({
    where: { id },
    include: {
      author: { select: { id: true, username: true, avatar: true, level: true, bio: true } },
      board: { select: { id: true, name: true, slug: true } },
      tea: { select: { id: true, name: true, brand: true, year: true } },
      _count: { select: { comments: true, likes: true, favorites: true } },
    },
  });

  // Detail-level visibility is fail-closed: only published+public is open.
  // draft/pending/private need author/admin; archived is admin-only; unknown
  // status is denied. 404 (not 403) so the very existence of a hidden article
  // is not leaked.
  const session = await auth();
  const viewable =
    !!article &&
    canViewArticleDetail(
      {
        status: article.status,
        visibility: article.visibility,
        authorId: article.authorId,
      },
      { userId: session?.user?.id, isAdmin: session?.user?.role === "admin" },
    );
  if (!article || !viewable) {
    return NextResponse.json({ error: "帖子不存在" }, { status: 404 });
  }

  return NextResponse.json(article);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { id } = await params;
  const article = await prisma.article.findUnique({ where: { id } });

  if (!article) {
    return NextResponse.json({ error: "帖子不存在" }, { status: 404 });
  }

  if (article.authorId !== session.user.id && session.user.role !== "admin") {
    return NextResponse.json({ error: "无权编辑此帖子" }, { status: 403 });
  }

  const { title, content, images, videoUrl, visibility } = await req.json();
  const data: Record<string, unknown> = {};
  if (title?.trim()) data.title = title.trim().slice(0, 200);
  if (content?.trim()) data.content = content.trim();
  if (images) data.images = images;
  if (videoUrl !== undefined) data.videoUrl = videoUrl || null;
  if (visibility === "public" || visibility === "private") data.visibility = visibility;

  // 编辑后重新过审(管理员编辑免审):防"先发干净帖,再编辑成违规"
  if ((data.title || data.content) && session.user.role !== "admin") {
    const mod = await screenContent(`${data.title ?? article.title} ${data.content ?? article.content}`);
    if (mod.decision === "reject") {
      return NextResponse.json({ error: "内容含违规信息,无法保存" }, { status: 400 });
    }
    if (mod.decision === "review") {
      data.status = "pending_review";
      data.moderation = mod;
    }
  }

  const updated = await prisma.article.update({
    where: { id },
    data,
  });

  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { id } = await params;
  const article = await prisma.article.findUnique({ where: { id } });

  if (!article) {
    return NextResponse.json({ error: "帖子不存在" }, { status: 404 });
  }

  if (article.authorId !== session.user.id && session.user.role !== "admin") {
    return NextResponse.json({ error: "无权删除此帖子" }, { status: 403 });
  }

  // Decrement board counters
  if (article.boardId) {
    await prisma.board.update({
      where: { id: article.boardId },
      data: {
        threadCount: { decrement: 1 },
        postCount: { decrement: 1 + article.replyCount },
      },
    });
  }

  await prisma.article.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
