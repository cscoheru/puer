import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";
import { invalidateLevelCache } from "@/lib/level-config";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ level: string }> }) {
  const { error } = await requireAdmin();
  if (error) return error;

  const { level } = await params;
  const levelNum = parseInt(level, 10);
  const body = await req.json();

  const data: Record<string, unknown> = {};
  if (body.name) data.name = body.name;
  if (typeof body.expRequired === "number") data.expRequired = body.expRequired;
  if (typeof body.daysRequired === "number") data.daysRequired = body.daysRequired;
  if (typeof body.postsRequired === "number") data.postsRequired = body.postsRequired;
  if (typeof body.commentsLikedRequired === "number") data.commentsLikedRequired = body.commentsLikedRequired;

  const updated = await prisma.levelConfig.update({
    where: { level: levelNum },
    data,
  });

  invalidateLevelCache();
  return Response.json(updated);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ level: string }> }) {
  const { error } = await requireAdmin();
  if (error) return error;

  const { level } = await params;
  const levelNum = parseInt(level, 10);
  if (levelNum === 0) return Response.json({ error: "不能删除默认等级" }, { status: 400 });

  await prisma.levelConfig.delete({ where: { level: levelNum } });
  invalidateLevelCache();
  return Response.json({ ok: true });
}
