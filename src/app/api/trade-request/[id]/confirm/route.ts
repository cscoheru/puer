import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteProps {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteProps) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const request = await prisma.tradeRequest.findUnique({ where: { id } });
  if (!request) {
    return NextResponse.json({ error: "未找到" }, { status: 404 });
  }
  if (request.requesterId !== session.user.id && request.responderId !== session.user.id) {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }
  if (request.status !== "accepted") {
    return NextResponse.json({ error: "请求未被接受，无法确认" }, { status: 400 });
  }

  const body = await req.json();
  const tradeMethod = body.tradeMethod;
  if (!tradeMethod || !["self_delivery", "platform_verification"].includes(tradeMethod)) {
    return NextResponse.json({ error: "请选择交易方式" }, { status: 400 });
  }

  if (tradeMethod === "platform_verification") {
    return NextResponse.json({ error: "平台验货功能开发中，敬请期待" }, { status: 400 });
  }

  const updated = await prisma.tradeRequest.update({
    where: { id },
    data: { tradeMethod },
  });

  const otherUserId = session.user.id === request.requesterId ? request.responderId : request.requesterId;
  await prisma.notification.create({
    data: {
      userId: otherUserId,
      type: "system",
      content: "对方选择了交易方式：自行交易，请确认免责声明以完成交易",
    },
  });

  return NextResponse.json(updated);
}
