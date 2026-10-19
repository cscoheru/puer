import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";
import { publishArticles } from "@/lib/article-publish";
import { removeTastingNotesForArticles, syncTastingNoteForArticle } from "@/lib/tasting-note-sync";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin();
  if (error) return error;
  const { id } = await params;

  const article = await prisma.article.findUnique({
    where: { id },
    include: {
      author: { select: { id: true, username: true, avatar: true, level: true, karma: true } },
      board: { select: { id: true, name: true, slug: true } },
      comments: {
        take: 50,
        orderBy: { createdAt: "desc" },
        include: { author: { select: { id: true, username: true, avatar: true } } },
      },
    },
  });

  if (!article) return Response.json({ error: "帖子不存在" }, { status: 404 });

  // Drafts are owned by the review gate (/admin/drafts): content management
  // must not display or mutate them, or review could be bypassed via direct URL.
  if (article.status === "draft") {
    return Response.json(
      { error: "该帖子是草稿，请到「草稿审校」中查看和操作" },
      { status: 404 }
    );
  }

  return Response.json({
    ...article,
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
    lastRepliedAt: article.lastRepliedAt?.toISOString() ?? null,
    comments: article.comments.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
  });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin();
  if (error) return error;
  const { id } = await params;

  const existing = await prisma.article.findUnique({ where: { id }, select: { status: true } });
  if (existing?.status === "draft") {
    return Response.json(
      { error: "草稿请到「草稿审校」中操作" },
      { status: 403 }
    );
  }

  const body = await req.json();
  // Publish goes through publishArticles so the author's exp and board counters
  // fire exactly once on the draft/pending→published transition; apply status
  // directly only for non-publish targets (e.g. "archived").
  const wantsPublish = body.status === "published";
  const data: Record<string, unknown> = {};
  if (!wantsPublish && body.status) data.status = body.status;
  if (typeof body.isPinned === "boolean") data.isPinned = body.isPinned;
  if (typeof body.isEssence === "boolean") data.isEssence = body.isEssence;
  if (typeof body.title === "string" && body.title.trim()) data.title = body.title.trim();
  if (typeof body.content === "string") data.content = body.content;

  const article = await prisma.article.update({ where: { id }, data });

  if (wantsPublish) {
    await publishArticles({ ids: [id], actorId: session.user.id });
    const fresh = await prisma.article.findUnique({ where: { id } });
    return Response.json({ ok: true, article: fresh ?? article });
  }

  // 管理员改标题/正文后同步镜像品鉴笔记（镜像笔记是源帖的派生副本）。
  // 归档（data.status === "archived"）不在这里同步 —— 归档期间笔记由读取侧抑制，
  // 重新发布时 publishArticles 会再同步一次。
  if (data.title || data.content !== undefined) {
    await syncTastingNoteForArticle(id);
  }

  return Response.json({ ok: true, article });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin();
  if (error) return error;
  const { id } = await params;

  const existing = await prisma.article.findUnique({ where: { id }, select: { status: true } });
  if (existing?.status === "draft") {
    return Response.json(
      { error: "草稿请到「草稿审校」中删除" },
      { status: 403 }
    );
  }

  await removeTastingNotesForArticles([id]);
  await prisma.article.delete({ where: { id } });
  return Response.json({ ok: true });
}
