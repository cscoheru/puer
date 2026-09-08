import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkUserCanPost } from "@/lib/check-mute";
import { publishCommentEffects } from "@/lib/comment-effects";
import { checkRateLimit, rateLimitKey, getClientIP, LIMIT_POST } from "@/lib/rate-limit";
import { screenContent } from "@/lib/moderation";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { canPost, reason } = await checkUserCanPost(session.user.id);
  if (!canPost) {
    return NextResponse.json({ error: reason }, { status: 403 });
  }

  // Rate limit: 10 comments per hour per IP
  const ip = getClientIP(req);
  const { allowed } = checkRateLimit(rateLimitKey(ip, `comment:${session.user.id}`), LIMIT_POST);
  if (!allowed) {
    return NextResponse.json({ error: "评论过于频繁，请稍后再试" }, { status: 429 });
  }

  const { articleId, tastingNoteId, content, parentId, images } = await req.json();
  if ((!articleId && !tastingNoteId) || !content?.trim()) {
    return NextResponse.json({ error: "参数不完整" }, { status: 400 });
  }

  if (content.trim().length < 5) {
    return NextResponse.json({ error: "评论至少5个字" }, { status: 400 });
  }

  // 内容审核:敏感词命中→拒绝;AI 放行→发布;可疑/故障→送审
  const mod = await screenContent(content);
  if (mod.decision === "reject") {
    return NextResponse.json({ error: "内容含违规信息,无法发布" }, { status: 400 });
  }
  const isPublish = mod.decision === "publish";

  const comment = await prisma.comment.create({
    data: {
      ...(articleId ? { articleId } : {}),
      ...(tastingNoteId ? { tastingNoteId } : {}),
      content: content.trim(),
      images: images || [],
      parentId: parentId || null,
      authorId: session.user.id,
      status: isPublish ? "published" : "pending_review",
      // 内联字面量:满足 Prisma Json 字段的索引签名要求
      moderation: isPublish
        ? undefined
        : { decision: mod.decision, categories: mod.categories, confidence: mod.confidence, reason: mod.reason, source: mod.source },
    },
    include: {
      author: { select: { id: true, username: true, avatar: true, level: true } },
    },
  });

  // 仅已发布评论触发副作用(计数/通知/经验);待审评论通过后由审核队列补发。
  if (isPublish) {
    await publishCommentEffects({
      commentId: comment.id,
      authorId: session.user.id,
      articleId,
      tastingNoteId,
      parentId,
    });
  }

  return NextResponse.json({ ...comment, pendingReview: !isPublish }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const articleId = searchParams.get("articleId");
  const tastingNoteId = searchParams.get("tastingNoteId");
  if (!articleId && !tastingNoteId) {
    return NextResponse.json({ error: "缺少 articleId 或 tastingNoteId" }, { status: 400 });
  }

  const session = await auth();

  // 待审评论仅管理员和评论作者本人可见;普通用户只见 published
  const baseWhere = articleId ? { articleId } : { tastingNoteId };
  const where =
    session?.user?.role === "admin"
      ? baseWhere
      : session?.user?.id
        ? { ...baseWhere, OR: [{ status: "published" }, { status: "pending_review", authorId: session.user.id }] }
        : { ...baseWhere, status: "published" };

  const comments = await prisma.comment.findMany({
    where,
    select: {
      id: true,
      content: true,
      images: true,
      status: true,
      createdAt: true,
      parentId: true,
      upvotes: true,
      downvotes: true,
      author: { select: { id: true, username: true, avatar: true, level: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // Attach user's vote state
  let voteMap = new Map<string, number>();
  if (session?.user?.id && comments.length > 0) {
    const votes = await prisma.vote.findMany({
      where: {
        userId: session.user.id,
        refId: { in: comments.map((c) => c.id) },
      },
      select: { refId: true, value: true },
    });
    votes.forEach((v) => voteMap.set(v.refId, v.value));
  }

  const enriched = comments.map((c) => ({
    ...c,
    initialVote: voteMap.get(c.id) || 0,
  }));

  return NextResponse.json(enriched);
}
