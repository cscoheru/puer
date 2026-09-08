import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { screenContent } from "@/lib/moderation";
import { visibleArticleWhere } from "@/lib/article-visibility";
import type { Prisma } from "@/generated/prisma/client";

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const sort = searchParams.get("sort") || "latest"; // latest | essence
  const limit = 20;

  const board = await prisma.board.findUnique({ where: { slug } });
  if (!board) {
    return NextResponse.json({ error: "版块不存在" }, { status: 404 });
  }

  const session = await auth();
  const where: Prisma.ArticleWhereInput = {
    boardId: board.id,
    ...visibleArticleWhere(session?.user?.id),
  };
  const orderBy: Record<string, string>[] = [{ isPinned: "desc" }];

  if (sort === "essence") {
    where["isEssence"] = true as const;
  }
  orderBy.push({ lastRepliedAt: "desc" }, { createdAt: "desc" });

  const [threads, total] = await Promise.all([
    prisma.article.findMany({
      where,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        title: true,
        type: true,
        isPinned: true,
        isEssence: true,
        replyCount: true,
        viewCount: true,
        lastRepliedAt: true,
        createdAt: true,
        author: { select: { id: true, username: true, avatar: true, level: true } },
        _count: { select: { likes: true } },
      },
    }),
    prisma.article.count({ where }),
  ]);

  return NextResponse.json({ board, threads, total, page, limit });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录后发帖" }, { status: 401 });
  }

  const { slug } = await params;
  const board = await prisma.board.findUnique({ where: { slug } });
  if (!board) {
    return NextResponse.json({ error: "版块不存在" }, { status: 404 });
  }

  const { title, content, flair, videoUrl, teaId, images, visibility } = await req.json();
  if (!title || !title.trim()) {
    return NextResponse.json({ error: "请输入标题" }, { status: 400 });
  }
  if ((!content || !content.trim()) && !videoUrl) {
    return NextResponse.json({ error: "请输入内容" }, { status: 400 });
  }

  // Karma threshold check
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { karma: true },
  });
  if (!user) {
    return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  }
  if (user.karma < board.minKarma) {
    return NextResponse.json(
      { error: `需要 ${board.minKarma} 社区声望才能在此版块发帖，当前 ${user.karma}` },
      { status: 403 },
    );
  }

  // 内容审核:敏感词命中→拒绝;AI 放行→发布;可疑/故障→送审
  const mod = await screenContent(`${title} ${content || ""}`);
  if (mod.decision === "reject") {
    return NextResponse.json({ error: "内容含违规信息,无法发布" }, { status: 400 });
  }
  const isPublish = mod.decision === "publish";

  const now = new Date();
  const article = await prisma.article.create({
    data: {
      type: "discussion",
      title: title.trim().slice(0, 200),
      content: (content || "").trim(),
      videoUrl: videoUrl || null,
      images: images || [],
      flair: flair || null,
      teaId: teaId || null,
      boardId: board.id,
      authorId: session.user.id,
      status: isPublish ? "published" : "pending_review",
      visibility: visibility === "private" ? "private" : "public",
      moderation: isPublish
        ? undefined
        : { decision: mod.decision, categories: mod.categories, confidence: mod.confidence, reason: mod.reason, source: mod.source },
      lastRepliedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });

  // 仅已发布帖计入版块计数;待审帖通过后由审核队列补发
  if (isPublish) {
    await prisma.board.update({
      where: { id: board.id },
      data: {
        threadCount: { increment: 1 },
        postCount: { increment: 1 },
        lastPostedAt: now,
      },
    });
  }

  return NextResponse.json({ ...article, pendingReview: !isPublish }, { status: 201 });
}
