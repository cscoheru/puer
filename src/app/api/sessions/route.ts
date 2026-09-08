import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { INVITE_MINIMUM } from "@/lib/session-constants";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status");
  const invited = searchParams.get("invited");
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") || "20", 10)));
  const sessionUser = await auth();

  const where: Record<string, unknown> = {};
  if (status === "live") {
    where.status = "live";
  } else if (status === "ended") {
    where.status = "ended";
  } else if (status === "inviting") {
    where.status = "inviting";
  } else if (status === "confirmed") {
    where.status = "confirmed";
  } else if (status === "expired") {
    where.status = "expired";
  }

  // "My invitations" mode
  if (invited === "true" && sessionUser?.user) {
    where.invitations = {
      some: { inviteeId: sessionUser.user.id, status: "pending" },
    };
  }

  const sessions = await prisma.teaSession.findMany({
    where,
    include: {
      host: { select: { id: true, username: true, avatar: true, level: true, onlineStatus: true } },
      tea: { select: { id: true, name: true, type: true } },
      _count: { select: { messages: true, invitations: true, participants: true } },
    },
    orderBy: status === "live" ? { startedAt: "desc" } : { createdAt: "desc" },
    skip: (page - 1) * limit,
    take: limit,
  });

  const total = await prisma.teaSession.count({ where });

  return Response.json({ sessions, total, page, limit });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }
  if ((session.user.level ?? 0) < 2) {
    return Response.json({ error: "需要 Lv.2 茶人以上才能发起茶会" }, { status: 403 });
  }

  const body = await req.json();
  const { title, teaId, teaName, description, images, brewMethod, waterTemp, teaWeight,
    scheduledAt, duration, invitedUserIds } = body;

  if (!title || !title.trim()) {
    return Response.json({ error: "标题不能为空" }, { status: 400 });
  }
  if (!teaName || !teaName.trim()) {
    return Response.json({ error: "茶品名称不能为空" }, { status: 400 });
  }
  if (title.length > 200) {
    return Response.json({ error: "标题不能超过200字" }, { status: 400 });
  }
  if (!scheduledAt) {
    return Response.json({ error: "请选择茶会时间" }, { status: 400 });
  }
  if (!duration || duration < 15) {
    return Response.json({ error: "茶会时长至少15分钟" }, { status: 400 });
  }

  // Validate invitedUserIds
  if (!Array.isArray(invitedUserIds) || invitedUserIds.length < INVITE_MINIMUM) {
    return Response.json({ error: `至少邀请 ${INVITE_MINIMUM} 位茶友` }, { status: 400 });
  }

  // Validate teaId if provided
  if (teaId) {
    const tea = await prisma.tea.findUnique({ where: { id: teaId }, select: { id: true } });
    if (!tea) {
      return Response.json({ error: "茶品不存在" }, { status: 400 });
    }
  }

  // Verify all invited users exist
  const invitees = await prisma.user.findMany({
    where: { id: { in: invitedUserIds } },
    select: { id: true },
  });
  if (invitees.length !== invitedUserIds.length) {
    return Response.json({ error: "部分受邀用户不存在" }, { status: 400 });
  }

  const scheduledDate = new Date(scheduledAt);
  if (scheduledDate <= new Date()) {
    return Response.json({ error: "茶会时间必须在当前时间之后" }, { status: 400 });
  }

  const newSession = await prisma.teaSession.create({
    data: {
      title: title.trim(),
      teaName: teaName.trim(),
      description: description || null,
      coverImage: images?.[0] || null,
      images: images || [],
      brewMethod: brewMethod || null,
      waterTemp: waterTemp ? parseInt(waterTemp, 10) : null,
      teaWeight: teaWeight || null,
      teaId: teaId || null,
      hostId: session.user.id,
      duration,
      status: "inviting",
      scheduledAt: scheduledDate,
    },
    include: {
      host: { select: { id: true, username: true, avatar: true, level: true } },
    },
  });

  // Create invitations
  await prisma.sessionInvitation.createMany({
    data: invitedUserIds.map((uid: string) => ({
      sessionId: newSession.id,
      inviterId: session.user.id,
      inviteeId: uid,
    })),
  });

  // Push real-time invitation notifications
  try {
    const wsUrl = "http://puer-hub-ws:3011";
    await fetch(`${wsUrl}/internal/invitation-created`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteeIds: invitedUserIds,
        session: {
          id: newSession.id,
          title: newSession.title,
          teaName: newSession.teaName,
          coverImage: newSession.coverImage,
          scheduledAt: newSession.scheduledAt,
          duration: newSession.duration,
          host: newSession.host,
        },
      }),
    });
  } catch {
    // non-blocking: ws-server may not be reachable
  }

  return Response.json(newSession, { status: 201 });
}
