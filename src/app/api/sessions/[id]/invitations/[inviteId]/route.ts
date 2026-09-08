import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Accept or decline an invitation */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; inviteId: string }> }) {
  const { id, inviteId } = await params;
  const sessionUser = await auth();
  if (!sessionUser?.user) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }

  const invitation = await prisma.sessionInvitation.findUnique({
    where: { id: inviteId },
    include: { session: { select: { hostId: true, status: true } } },
  });
  if (!invitation) return Response.json({ error: "邀请不存在" }, { status: 404 });
  if (invitation.inviteeId !== sessionUser.user.id)
    return Response.json({ error: "无权操作此邀请" }, { status: 403 });
  if (invitation.status !== "pending")
    return Response.json({ error: "邀请已处理" }, { status: 400 });
  if (invitation.session.status !== "inviting")
    return Response.json({ error: "茶席不在邀请阶段" }, { status: 400 });

  const body = await req.json();
  const { action } = body;
  if (action !== "accepted" && action !== "declined") {
    return Response.json({ error: "操作无效" }, { status: 400 });
  }

  const updated = await prisma.sessionInvitation.update({
    where: { id: inviteId },
    data: { status: action, respondedAt: new Date() },
  });

  // Notify host about the response
  try {
    const hostId = invitation.session.hostId;
    const invitee = await prisma.user.findUnique({
      where: { id: sessionUser.user.id },
      select: { id: true, username: true, avatar: true },
    });
    await fetch("http://puer-hub-ws:3011/internal/invitation-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hostId,
        invitation: {
          sessionId: id,
          action,
          invitee,
        },
      }),
    });
  } catch {
    // non-blocking
  }

  // If all invitations are now accepted (no pending left), auto-transition to confirmed
  if (action === "accepted") {
    const pendingCount = await prisma.sessionInvitation.count({
      where: { sessionId: id, status: "pending" },
    });
    if (pendingCount === 0) {
      await prisma.teaSession.update({
        where: { id },
        data: { status: "confirmed" },
      });
    }
  }

  return Response.json(updated);
}
