import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { INVITE_MINIMUM } from "@/lib/session-constants";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const invitations = await prisma.sessionInvitation.findMany({
    where: { sessionId: id },
    include: {
      inviter: { select: { id: true, username: true, avatar: true } },
      invitee: { select: { id: true, username: true, avatar: true, level: true, onlineStatus: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return Response.json(invitations);
}

/** Send invitations (host only) */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionUser = await auth();
  if (!sessionUser?.user) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }

  const existing = await prisma.teaSession.findUnique({
    where: { id },
    select: {
      hostId: true,
      status: true,
      title: true,
      teaName: true,
      coverImage: true,
      scheduledAt: true,
      duration: true,
      host: { select: { id: true, username: true, avatar: true, level: true } },
    },
  });
  if (!existing) return Response.json({ error: "茶席不存在" }, { status: 404 });
  if (existing.hostId !== sessionUser.user.id)
    return Response.json({ error: "只有室主可以邀请" }, { status: 403 });
  if (existing.status !== "inviting")
    return Response.json({ error: "当前状态不可邀请" }, { status: 400 });

  const body = await req.json();
  const { userIds } = body;
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return Response.json({ error: "请选择要邀请的用户" }, { status: 400 });
  }

  // Verify all users exist
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, username: true, onlineStatus: true },
  });
  if (users.length !== userIds.length) {
    return Response.json({ error: "部分用户不存在" }, { status: 400 });
  }

  // Check total including existing invitations
  const existingCount = await prisma.sessionInvitation.count({
    where: { sessionId: id, status: { not: "declined" } },
  });

  const created = await Promise.all(
    users.map((u) =>
      prisma.sessionInvitation.upsert({
        where: { sessionId_inviteeId: { sessionId: id, inviteeId: u.id } },
        update: { status: "pending", respondedAt: null },
        create: {
          sessionId: id,
          inviterId: sessionUser.user.id,
          inviteeId: u.id,
        },
      })
    )
  );

  const totalInvited = existingCount + userIds.length;

  // Push real-time invitation notifications
  try {
    const wsUrl = "http://puer-hub-ws:3011";
    await fetch(`${wsUrl}/internal/invitation-created`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteeIds: userIds,
        session: {
          id,
          title: existing.title,
          teaName: existing.teaName,
          coverImage: existing.coverImage,
          scheduledAt: existing.scheduledAt,
          duration: existing.duration,
          host: existing.host,
        },
      }),
    });
  } catch {
    // non-blocking
  }

  return Response.json({ invitations: created, totalInvited }, { status: 201 });
}
