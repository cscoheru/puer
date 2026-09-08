import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const session = await prisma.teaSession.findUnique({
    where: { id },
    include: {
      host: { select: { id: true, username: true, avatar: true, level: true, onlineStatus: true } },
      tea: { select: { id: true, name: true, type: true, coverImage: true } },
      invitations: {
        include: {
          invitee: { select: { id: true, username: true, avatar: true, level: true, onlineStatus: true } },
        },
      },
      _count: { select: { messages: true, gallery: true, invitations: true, participants: true } },
    },
  });

  if (!session) {
    return Response.json({ error: "茶席不存在" }, { status: 404 });
  }

  return Response.json(session);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionUser = await auth();
  if (!sessionUser?.user) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }

  const existing = await prisma.teaSession.findUnique({
    where: { id },
    select: { hostId: true, status: true },
  });
  if (!existing) {
    return Response.json({ error: "茶席不存在" }, { status: 404 });
  }
  if (existing.hostId !== sessionUser.user.id) {
    return Response.json({ error: "只有室主可以修改" }, { status: 403 });
  }

  const body = await req.json();
  const { title, description, coverImage, brewMethod, waterTemp, teaWeight,
    scheduledAt, duration, images } = body;

  const data: Record<string, unknown> = {};
  if (title !== undefined) data.title = title;
  if (description !== undefined) data.description = description;
  if (coverImage !== undefined) data.coverImage = coverImage;
  if (brewMethod !== undefined) data.brewMethod = brewMethod;
  if (waterTemp !== undefined) data.waterTemp = waterTemp;
  if (teaWeight !== undefined) data.teaWeight = teaWeight;
  if (images !== undefined) {
    data.images = images;
    if (images.length > 0) data.coverImage = images[0];
  }
  // Allow scheduling update only while inviting
  if (existing.status === "inviting") {
    if (scheduledAt !== undefined) data.scheduledAt = new Date(scheduledAt);
    if (duration !== undefined) data.duration = duration;
  }

  const updated = await prisma.teaSession.update({
    where: { id },
    data,
    include: {
      host: { select: { id: true, username: true, avatar: true, level: true } },
    },
  });

  return Response.json(updated);
}
