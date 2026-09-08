import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteProps {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteProps) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const request = await prisma.tradeRequest.findUnique({
    where: { id },
    include: {
      requester: { select: { id: true, username: true, avatar: true, level: true } },
      responder: { select: { id: true, username: true, avatar: true, level: true } },
      inventoryItem: true,
    },
  });

  if (!request) {
    return NextResponse.json({ error: "未找到" }, { status: 404 });
  }
  if (request.requesterId !== session.user.id && request.responderId !== session.user.id) {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  return NextResponse.json(request);
}
