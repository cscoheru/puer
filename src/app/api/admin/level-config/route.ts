import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";
import { invalidateLevelCache } from "@/lib/level-config";

export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;

  const configs = await prisma.levelConfig.findMany({ orderBy: { level: "asc" } });
  return Response.json({ levels: configs });
}

export async function POST(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  const { level, name, expRequired, daysRequired, postsRequired, commentsLikedRequired } = await req.json();
  if (level == null || !name) return Response.json({ error: "等级和名称不能为空" }, { status: 400 });

  const existing = await prisma.levelConfig.findUnique({ where: { level } });
  if (existing) return Response.json({ error: "等级已存在" }, { status: 400 });

  const created = await prisma.levelConfig.create({
    data: {
      level,
      name,
      expRequired: expRequired ?? 0,
      daysRequired: daysRequired ?? 0,
      postsRequired: postsRequired ?? 0,
      commentsLikedRequired: commentsLikedRequired ?? 0,
    },
  });

  invalidateLevelCache();
  return Response.json(created, { status: 201 });
}
