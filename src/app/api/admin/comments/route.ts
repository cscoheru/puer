import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  const { searchParams } = req.nextUrl;
  const keyword = searchParams.get("keyword");
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20", 10)));

  const where: Record<string, unknown> = {};
  if (keyword) where.content = { contains: keyword, mode: "insensitive" };

  const [comments, total] = await Promise.all([
    prisma.comment.findMany({
      where,
      include: {
        author: { select: { id: true, username: true, avatar: true } },
        article: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.comment.count({ where }),
  ]);

  return Response.json({
    comments: comments.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
    total, page, limit,
  });
}

export async function DELETE(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  const { id } = await req.json();
  if (!id) return Response.json({ error: "缺少 id" }, { status: 400 });

  await prisma.comment.delete({ where: { id } });
  return Response.json({ ok: true });
}
