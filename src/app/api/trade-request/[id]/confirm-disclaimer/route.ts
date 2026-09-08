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
  if (request.requesterId !== session.user.id && request.responderId !== session.user.id) {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }
  if (request.status !== "accepted") {
    return NextResponse.json({ error: "请求状态不正确" }, { status: 400 });
  }
  if (!request.tradeMethod) {
    return NextResponse.json({ error: "请先选择交易方式" }, { status: 400 });
  }

  const isRequester = session.user.id === request.requesterId;

  // Already confirmed?
  if (isRequester && request.requesterConfirmedDisclaimer) {
    return NextResponse.json({ error: "你已确认过免责声明" }, { status: 400 });
  }
  if (!isRequester && request.responderConfirmedDisclaimer) {
    return NextResponse.json({ error: "你已确认过免责声明" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: Record<string, any> = {};
  if (isRequester) {
    data.requesterConfirmedDisclaimer = true;
  } else {
    data.responderConfirmedDisclaimer = true;
  }

  // Both confirmed → move to confirmed
  const bothConfirmed =
    (isRequester && request.responderConfirmedDisclaimer) ||
    (!isRequester && request.requesterConfirmedDisclaimer);

  if (bothConfirmed) {
    data.status = "confirmed";
  }

  const updated = await prisma.tradeRequest.update({ where: { id }, data });

  const otherUserId = isRequester ? request.responderId : request.requesterId;

  if (bothConfirmed) {
    await prisma.notification.create({
      data: {
        userId: otherUserId,
        type: "system",
        content: "交易已确认完成！请自行联系对方完成交易。提醒：交易有风险，请确认钱款和茶版符合要求，关于本交易产生的纠纷与本平台无关。",
      },
    });
  } else {
    await prisma.notification.create({
      data: {
        userId: otherUserId,
        type: "system",
        content: "对方已确认免责声明，请你也确认以完成交易",
      },
    });
  }

  return NextResponse.json(updated);
}
