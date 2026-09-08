import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";
import { grantExp } from "@/lib/exp";
import { pingSearchEngines } from "@/lib/sitemap-ping";
import { createNotification } from "@/lib/notifications";
import { publishCommentEffects } from "@/lib/comment-effects";

/**
 * PUT /api/admin/reviews/[id] — 审批一条待审内容。
 * body: { action: "approve" | "reject", kind: "article" | "comment", reason?: string }
 *
 * approve 时补发该内容"被推迟到通过才生效"的副作用:
 *  - 帖子:发帖经验 + 推搜索引擎
 *  - 评论:回复计数/版块计数/通知作者/评论经验(见 publishCommentEffects)
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { action, kind, reason } = body as { action?: string; kind?: string; reason?: string };

  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "action 必须为 approve 或 reject" }, { status: 400 });
  }
  if (kind !== "article" && kind !== "comment") {
    return NextResponse.json({ error: "kind 必须为 article 或 comment" }, { status: 400 });
  }

  const adminId = session.user.id;
  const now = new Date();

  if (kind === "article") {
    const article = await prisma.article.findUnique({
      where: { id },
      select: { id: true, authorId: true, type: true, title: true, status: true },
    });
    if (!article) return NextResponse.json({ error: "帖子不存在" }, { status: 404 });
    if (article.status !== "pending_review") {
      return NextResponse.json({ error: "该帖子不在待审队列" }, { status: 400 });
    }
    const titlePreview = article.title.slice(0, 30);

    if (action === "approve") {
      await prisma.article.update({
        where: { id },
        data: { status: "published", moderatedBy: adminId, moderatedAt: now },
      });
      // 补发:发帖经验 + 推搜索引擎
      const expType = article.type === "tasting" ? "post_tasting" : "post_article";
      await grantExp(article.authorId, expType, article.id).catch(() => {});
      pingSearchEngines();
      await createNotification(
        article.authorId, "system",
        `你的帖子「${titlePreview}」已通过审核`,
        `/forum/thread/${article.id}`,
      ).catch(() => {});
    } else {
      await prisma.article.update({
        where: { id },
        data: { status: "archived", moderatedBy: adminId, moderatedAt: now },
      });
      await createNotification(
        article.authorId, "system",
        `你的帖子「${titlePreview}」未通过审核${reason ? `：${reason}` : ""}`,
      ).catch(() => {});
    }
    return NextResponse.json({ success: true });
  }

  // kind === "comment"
  const comment = await prisma.comment.findUnique({
    where: { id },
    select: { id: true, authorId: true, articleId: true, tastingNoteId: true, parentId: true, status: true },
  });
  if (!comment) return NextResponse.json({ error: "评论不存在" }, { status: 404 });
  if (comment.status !== "pending_review") {
    return NextResponse.json({ error: "该评论不在待审队列" }, { status: 400 });
  }

  if (action === "approve") {
    await prisma.comment.update({
      where: { id },
      data: { status: "published", moderatedBy: adminId, moderatedAt: now },
    });
    // 补发:回复计数/版块计数/通知作者/评论经验
    await publishCommentEffects({
      commentId: comment.id,
      authorId: comment.authorId,
      articleId: comment.articleId,
      tastingNoteId: comment.tastingNoteId,
      parentId: comment.parentId,
    }).catch(() => {});
    await createNotification(
      comment.authorId, "system",
      `你的评论已通过审核`,
      comment.articleId ? `/forum/thread/${comment.articleId}` : undefined,
    ).catch(() => {});
  } else {
    await prisma.comment.update({
      where: { id },
      data: { status: "rejected", moderatedBy: adminId, moderatedAt: now },
    });
    await createNotification(
      comment.authorId, "system",
      `你的评论未通过审核${reason ? `：${reason}` : ""}`,
    ).catch(() => {});
  }
  return NextResponse.json({ success: true });
}
