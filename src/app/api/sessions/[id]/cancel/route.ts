import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionUser = await auth();
  if (!sessionUser?.user) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }

  const existing = await prisma.teaSession.findUnique({
    where: { id },
    select: { hostId: true, status: true },
  });
  if (!existing) return Response.json({ error: "茶席不存在" }, { status: 404 });
  if (existing.hostId !== sessionUser.user.id)
    return Response.json({ error: "只有室主可以取消" }, { status: 403 });
  if (existing.status !== "inviting" && existing.status !== "confirmed")
    return Response.json({ error: "当前状态不可取消" }, { status: 400 });

  const updated = await prisma.teaSession.update({
    where: { id },
    data: { status: "cancelled" },
  });

  // Notify ws-server
  try {
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "http://ws-server:3003";
    fetch(`${wsUrl.replace(/^https?:\/\//, "http://")}/internal/session-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: id, event: "cancelled" }),
    }).catch(() => {});
  } catch {}

  return Response.json(updated);
}
