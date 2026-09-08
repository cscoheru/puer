import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

type ModInfo = {
  categories?: string[];
  confidence?: number;
  reason?: string;
  source?: string;
} | null;

/**
 * GET /api/admin/reviews — 待审队列(合并 pending_review 的帖子与评论)。
 * 两表结构不同,这里各自拉取后归一化、按时间倒序合并,内存分页。
 * 队列规模通常很小(机器人刷量是另一类问题),take 上限 500 足够。
 */
export async function GET(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  const { searchParams } = req.nextUrl;
  const kind = searchParams.get("kind"); // article | comment | 空(全部)
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20", 10)));

  const authorSelect = { id: true, username: true, avatar: true } as const;

  const [articles, comments] = await Promise.all([
    !kind || kind === "article"
      ? prisma.article.findMany({
          where: { status: "pending_review" },
          select: {
            id: true, type: true, title: true, authorId: true, createdAt: true, moderation: true,
            author: { select: authorSelect },
          },
          orderBy: { createdAt: "desc" },
          take: 500,
        })
      : Promise.resolve([]),
    !kind || kind === "comment"
      ? prisma.comment.findMany({
          where: { status: "pending_review" },
          select: {
            id: true, content: true, articleId: true, tastingNoteId: true, authorId: true, createdAt: true, moderation: true,
            author: { select: authorSelect },
          },
          orderBy: { createdAt: "desc" },
          take: 500,
        })
      : Promise.resolve([]),
  ]);

  // 批量取评论所属帖子标题(给管理员上下文)
  const commentArticleIds = [...new Set(comments.map((c) => c.articleId).filter(Boolean))] as string[];
  const titleMap = new Map<string, string>();
  if (commentArticleIds.length) {
    const arts = await prisma.article.findMany({
      where: { id: { in: commentArticleIds } },
      select: { id: true, title: true },
    });
    arts.forEach((a) => titleMap.set(a.id, a.title));
  }

  const items = [
    ...articles.map((a) => ({
      kind: "article" as const,
      id: a.id,
      preview: a.title,
      type: a.type,
      author: a.author,
      createdAt: a.createdAt.toISOString(),
      moderation: a.moderation as ModInfo,
    })),
    ...comments.map((c) => ({
      kind: "comment" as const,
      id: c.id,
      preview: c.content.slice(0, 200),
      articleId: c.articleId,
      articleTitle: c.articleId ? (titleMap.get(c.articleId) ?? null) : null,
      tastingNoteId: c.tastingNoteId,
      author: c.author,
      createdAt: c.createdAt.toISOString(),
      moderation: c.moderation as ModInfo,
    })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const total = items.length;
  const paged = items.slice((page - 1) * limit, page * limit);

  return Response.json({ items: paged, total, page, limit });
}
