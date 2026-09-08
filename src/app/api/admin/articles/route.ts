import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status");
  const boardId = searchParams.get("boardId");
  const keyword = searchParams.get("keyword");
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20", 10)));

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (boardId) where.boardId = boardId;
  if (keyword) where.title = { contains: keyword, mode: "insensitive" };

  // Content management never lists drafts — they belong to the review gate at
  // /admin/drafts. A `status=draft` query here is treated as empty.
  if (!where.status || where.status === "draft") {
    where.status = { not: "draft" };
  }

  const [articles, total] = await Promise.all([
    prisma.article.findMany({
      where,
      include: {
        author: { select: { id: true, username: true, avatar: true } },
        board: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.article.count({ where }),
  ]);

  return Response.json({
    articles: articles.map((a) => ({
      ...a,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
      lastRepliedAt: a.lastRepliedAt?.toISOString() ?? null,
    })),
    total,
    page,
    limit,
  });
}
