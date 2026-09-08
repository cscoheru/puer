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
    return NextResponse.json({ error: "只有茶版主人可以接受请求" }, { status: 403 });
  }
  if (request.status !== "pending") {
    return NextResponse.json({ error: "请求状态不可操作" }, { status: 400 });
  }

  const updated = await prisma.tradeRequest.update({
    where: { id },
    data: { status: "accepted" },
  });

  // Notify requester
  await prisma.notification.create({
    data: {
      userId: request.requesterId,
      type: "system",
      content: "你的交易请求已被接受，请确认交易方式",
      link: `/user/${request.responderId}?tab=inventory`,
    },
  });

  // Supersede other pending requests for the same inventory item
  if (request.inventoryItemId) {
    const otherRequests = await prisma.tradeRequest.findMany({
      where: {
        inventoryItemId: request.inventoryItemId,
        status: "pending",
        id: { not: id },
      },
      select: { id: true, requesterId: true },
    });

    if (otherRequests.length > 0) {
      await prisma.tradeRequest.updateMany({
        where: {
          id: { in: otherRequests.map((r) => r.id) },
        },
        data: { status: "superseded" },
      });

      // Notify superseded requesters
      await prisma.notification.createMany({
        data: otherRequests.map((r) => ({
          userId: r.requesterId,
          type: "system",
          content: "你关注的茶版已被其他交易接受，你的请求已失效",
          link: `/exchange`,
        })),
      });
    }
  }

  return NextResponse.json(updated);
}
