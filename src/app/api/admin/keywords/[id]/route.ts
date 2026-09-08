import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin();
  if (error) return error;
  const { id } = await params;

  const body = await req.json();
  const data: Record<string, unknown> = {};
  if (body.keyword) data.keyword = body.keyword;
  if (body.category) data.category = body.category;
  if (typeof body.isActive === "boolean") data.isActive = body.isActive;

  const updated = await prisma.sensitiveKeyword.update({ where: { id }, data });
  return Response.json(updated);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin();
  if (error) return error;
  const { id } = await params;

  await prisma.sensitiveKeyword.delete({ where: { id } });
  return Response.json({ ok: true });
}
