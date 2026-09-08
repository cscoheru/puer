import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;

  const announcements = await prisma.announcement.findMany({
    orderBy: { createdAt: "desc" },
    include: { creator: { select: { id: true, username: true } } },
  });

  return Response.json({
    announcements: announcements.map((a) => ({
      ...a,
      createdAt: a.createdAt.toISOString(),
      expiresAt: a.expiresAt?.toISOString() ?? null,
    })),
  });
}

export async function POST(req: NextRequest) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const { title, content, type, expiresAt } = await req.json();
  if (!title || !content) return Response.json({ error: "标题和内容不能为空" }, { status: 400 });

  const created = await prisma.announcement.create({
    data: {
      title,
      content,
      type: type || "info",
      createdBy: session!.user.id,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    },
  });

  return Response.json(created, { status: 201 });
}
