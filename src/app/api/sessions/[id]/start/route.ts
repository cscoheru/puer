import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { CREDIT_DEDUCT_NO_SHOW } from "@/lib/session-constants";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionUser = await auth();
  if (!sessionUser?.user) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }

  const existing = await prisma.teaSession.findUnique({
    where: { id },
    select: { hostId: true, status: true, scheduledAt: true },
  });

  if (!existing) {
    return Response.json({ error: "茶席不存在" }, { status: 404 });
  }
  if (existing.hostId !== sessionUser.user.id) {
    return Response.json({ error: "只有室主可以开席" }, { status: 403 });
  }
  if (existing.status !== "confirmed") {
    return Response.json({ error: "茶席未确认，请先等待受邀好友确认" }, { status: 400 });
  }

  // Check if host has entered the room before scheduled time
  const hostParticipant = await prisma.sessionParticipant.findUnique({
    where: { sessionId_userId: { sessionId: id, userId: sessionUser.user.id } },
  });
  if (!hostParticipant) {
    // Host didn't join → expire session
    await prisma.teaSession.update({
      where: { id },
      data: { status: "expired", endedAt: new Date() },
    });
    return Response.json({ error: "发起人未在约定时间前进入茶席，茶会已过期" }, { status: 400 });
  }

  // Check scheduled time
  if (existing.scheduledAt && new Date() < existing.scheduledAt) {
    return Response.json({ error: "茶会时间尚未到达" }, { status: 400 });
  }

  const updated = await prisma.teaSession.update({
    where: { id },
    data: { status: "live", startedAt: new Date() },
  });

  // No-show penalty for accepted invitees who never joined
  const acceptedInvites = await prisma.sessionInvitation.findMany({
    where: { sessionId: id, status: "accepted" },
    select: { inviteeId: true },
  });
  for (const inv of acceptedInvites) {
    const joined = await prisma.sessionParticipant.findUnique({
      where: { sessionId_userId: { sessionId: id, userId: inv.inviteeId } },
    });
    if (!joined) {
      await prisma.user.update({
        where: { id: inv.inviteeId },
        data: {
          noShowCount: { increment: 1 },
          creditScore: { decrement: CREDIT_DEDUCT_NO_SHOW },
        },
      });
      await prisma.sessionInvitation.update({
        where: { sessionId_inviteeId: { sessionId: id, inviteeId: inv.inviteeId } },
        data: { status: "no_show" },
      });
    }
  }

  // Notify ws-server (non-blocking)
  try {
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "http://ws-server:3003";
    fetch(`${wsUrl.replace(/^https?:\/\//, "http://")}/internal/session-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: id, event: "started" }),
    }).catch(() => {});
  } catch {}

  return Response.json(updated);
}
