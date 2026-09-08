import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteProps {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, { params }: RouteProps) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const request = await prisma.tradeRequest.findUnique({ where: { id } });
  if (!request) {
    return NextResponse.json({ error: "未找到" }, { status: 404 });
  }
  if (request.responderId !== session.user.id) {
    return NextResponse.json({ error: "只有茶版主人可以拒绝请求" }, { status: 403 });
  }
  if (request.status !== "pending") {
    return NextResponse.json({ error: "请求状态不可操作" }, { status: 400 });
  }

  const updated = await prisma.tradeRequest.update({
    where: { id },
    data: { status: "rejected" },
  });

  await prisma.notification.create({
    data: {
      userId: request.requesterId,
      type: "system",
      content: "你的交易请求已被拒绝",
    },
  });

  return NextResponse.json(updated);
}
