import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { grantExp } from "@/lib/exp";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionUser = await auth();
  if (!sessionUser?.user) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }

  const existing = await prisma.teaSession.findUnique({
    where: { id },
    select: { hostId: true, status: true, startedAt: true },
  });

  if (!existing) {
    return Response.json({ error: "茶席不存在" }, { status: 404 });
  }
  if (existing.hostId !== sessionUser.user.id) {
    return Response.json({ error: "只有室主可以结席" }, { status: 403 });
  }
  if (existing.status !== "live") {
    return Response.json({ error: "茶席未开始" }, { status: 400 });
  }

  // Record leftAt for all online participants
  await prisma.sessionParticipant.updateMany({
    where: { sessionId: id, leftAt: null },
    data: { leftAt: new Date() },
  });

  const updated = await prisma.teaSession.update({
    where: { id },
    data: { status: "ended", endedAt: new Date() },
  });

  // Grant exp
  grantExp(sessionUser.user.id, "tea_session_host", id).catch(() => {});
  if (existing.startedAt) {
    const duration = Date.now() - existing.startedAt.getTime();
    if (duration > 30 * 60 * 1000) {
      grantExp(sessionUser.user.id, "tea_session_long", id).catch(() => {});
    }
  }

  // Notify ws-server (non-blocking)
  try {
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "http://ws-server:3003";
    fetch(`${wsUrl.replace(/^https?:\/\//, "http://")}/internal/session-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: id, event: "ended" }),
    }).catch(() => {});
  } catch {}

  return Response.json(updated);
}
