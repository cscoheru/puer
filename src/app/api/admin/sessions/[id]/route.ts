import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin();
  if (error) return error;
  const { id } = await params;

  const session = await prisma.teaSession.findUnique({
    where: { id },
    include: {
      host: { select: { id: true, username: true, avatar: true, level: true } },
      participants: {
        include: { user: { select: { id: true, username: true, avatar: true } } },
        orderBy: { enteredAt: "desc" },
      },
      invitations: {
        include: {
          invitee: { select: { id: true, username: true, avatar: true } },
        },
      },
      messages: {
        take: 30,
        orderBy: { createdAt: "desc" },
        include: { user: { select: { id: true, username: true } } },
      },
    },
  });

  if (!session) return Response.json({ error: "茶会不存在" }, { status: 404 });

  return Response.json({
    ...session,
    createdAt: session.createdAt.toISOString(),
    scheduledAt: session.scheduledAt?.toISOString() ?? null,
    startedAt: session.startedAt?.toISOString() ?? null,
    endedAt: session.endedAt?.toISOString() ?? null,
    participants: session.participants.map((p) => ({
      ...p,
      enteredAt: p.enteredAt.toISOString(),
      leftAt: p.leftAt?.toISOString() ?? null,
    })),
    messages: session.messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
  });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin();
  if (error) return error;
  const { id } = await params;

  const body = await req.json();
  const data: Record<string, unknown> = {};
  if (body.status) data.status = body.status;
  if (body.status === "cancelled") data.endedAt = new Date();

  await prisma.teaSession.update({ where: { id }, data });
  return Response.json({ ok: true });
}
