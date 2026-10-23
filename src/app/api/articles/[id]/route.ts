import { NextRequest, NextResponse } from "next/server";
import { can } from "@/lib/permissions";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { screenContent } from "@/lib/moderation";
import { canViewArticleDetail } from "@/lib/article-visibility";
import { removeTastingNotesForArticles, syncTastingNoteForArticle } from "@/lib/tasting-note-sync";

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
      { userId: session?.user?.id, isAdmin: can(session?.user, "admin:access") },
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

  // 权限走统一层（PRD v0.3 §13）：本人用 own 动作，管理员用 any 动作。
  if (
    !can(session.user, "post:edit:own", { ownUserId: article.authorId }) &&
    !can(session.user, "post:edit:any", { ownUserId: article.authorId })
  ) {
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
  // 有 any 编辑权的人（管理员）改内容免重审 —— 否则批量修错别字会全进待审。
  if ((data.title || data.content) && !can(session.user, "post:edit:any")) {
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

  // 镜像笔记是源帖的派生副本：标题/正文/图/视频改了要跟着同步，
  // 否则品鉴时间线永远显示发布时的旧内容。sync 内部按帖子当前状态判断
  // （重新送审/翻私密会被规划器跳过，已镜像的那条则改由读取侧抑制）。
  if (data.title || data.content !== undefined || data.images !== undefined || data.videoUrl !== undefined || data.visibility) {
    await syncTastingNoteForArticle(id);
  }

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

  if (
    !can(session.user, "post:delete:own", { ownUserId: article.authorId }) &&
    !can(session.user, "post:delete:any", { ownUserId: article.authorId })
  ) {
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

  // 先删镜像品鉴笔记再删帖：反过来的话，帖子没了而笔记删失败，就会在茶档案页
  // 留下一张永远指向已删除帖子的孤儿笔记（TastingNote 与 Article 之间没有外键，
  // 删 Article 不会级联）。这个顺序的最坏情况只是「帖子还在但没笔记」，可被 backfill 修复。
  await removeTastingNotesForArticles([id]);

  await prisma.article.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
