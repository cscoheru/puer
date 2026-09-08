import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const role = searchParams.get("role") || "incoming";
  const status = searchParams.get("status");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {};
  if (role === "incoming") {
    where.responderId = session.user.id;
  } else {
    where.requesterId = session.user.id;
  }
  if (status) where.status = status;

  const requests = await prisma.tradeRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      requester: { select: { id: true, username: true, avatar: true, level: true, karma: true, followerCount: true, bio: true, teaAge: true, createdAt: true } },
      responder: { select: { id: true, username: true, avatar: true, level: true, karma: true, followerCount: true, bio: true, teaAge: true, createdAt: true } },
      inventoryItem: {
        select: { id: true, brand: true, type: true, year: true, spec: true, remainingWeight: true, images: true },
      },
      replies: { orderBy: { createdAt: "asc" } },
    },
  });

  return NextResponse.json({ data: requests });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const body = await req.json();
  const {
    inventoryItemId,
    requestType,
    offerSwapBrand, offerSwapType, offerSwapYear, offerSwapSpec, offerSwapWeight, offerSwapDesc,
    offerPrice,
    message,
  } = body;

  if (!inventoryItemId || !requestType) {
    return NextResponse.json({ error: "缺少必填字段" }, { status: 400 });
  }

  const item = await prisma.teaInventoryItem.findUnique({
    where: { id: inventoryItemId },
    select: { userId: true, status: true },
  });
  if (!item || item.status !== "active") {
    return NextResponse.json({ error: "茶版不存在或已下架" }, { status: 404 });
  }
  if (item.userId === session.user.id) {
    return NextResponse.json({ error: "不能对自己的茶版发起请求" }, { status: 400 });
  }

  if (requestType === "purchase" && !offerPrice) {
    return NextResponse.json({ error: "请填写出价" }, { status: 400 });
  }
  if (requestType === "swap" && !offerSwapBrand) {
    return NextResponse.json({ error: "请填写置换茶品信息" }, { status: 400 });
  }

  const request = await prisma.tradeRequest.create({
    data: {
      requesterId: session.user.id,
      responderId: item.userId,
      inventoryItemId,
      requestType,
      offerSwapBrand: offerSwapBrand || null,
      offerSwapType: offerSwapType || null,
      offerSwapYear: offerSwapYear ? parseInt(offerSwapYear, 10) : null,
      offerSwapSpec: offerSwapSpec || null,
      offerSwapWeight: offerSwapWeight ? parseInt(offerSwapWeight, 10) : null,
      offerSwapDesc: offerSwapDesc || null,
      offerPrice: offerPrice ? parseFloat(offerPrice) : null,
      message: message || null,
    },
  });

  // Increment request count on inventory item
  await prisma.teaInventoryItem.update({
    where: { id: inventoryItemId },
    data: { requestCount: { increment: 1 } },
  });

  // Notify the item owner
  await prisma.notification.create({
    data: {
      userId: item.userId,
      type: "system",
      content: `${session.user.name || "有人"} 想要你的茶版，${requestType === "swap" ? "提议置换" : "希望购买"}`,
      link: `/user/${item.userId}?tab=inventory`,
    },
  });

  return NextResponse.json(request, { status: 201 });
}
