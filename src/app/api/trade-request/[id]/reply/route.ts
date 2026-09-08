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

  const tradeRequest = await prisma.tradeRequest.findUnique({ where: { id } });
  if (!tradeRequest) {
    return NextResponse.json({ error: "请求不存在" }, { status: 404 });
  }

  if (tradeRequest.requesterId !== session.user.id && tradeRequest.responderId !== session.user.id) {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  if (tradeRequest.status !== "pending") {
    return NextResponse.json({ error: "只能回复待处理的请求" }, { status: 400 });
  }

  if (tradeRequest.round >= 2) {
    return NextResponse.json({ error: "已达最大还价次数（3轮）" }, { status: 400 });
  }

  const body = await req.json();
  const replyBy = tradeRequest.requesterId === session.user.id ? "requester" : "responder";
  const replyType = body.replyType || "message"; // message | counter_offer

  // Create reply record
  const reply = await prisma.tradeRequestReply.create({
    data: {
      tradeRequestId: id,
      replyBy,
      replyType,
      offerSwapBrand: body.offerSwapBrand || null,
      offerSwapType: body.offerSwapType || null,
      offerSwapYear: body.offerSwapYear ? parseInt(body.offerSwapYear, 10) : null,
      offerSwapSpec: body.offerSwapSpec || null,
      offerSwapWeight: body.offerSwapWeight ? parseInt(body.offerSwapWeight, 10) : null,
      offerSwapDesc: body.offerSwapDesc || null,
      offerPrice: body.offerPrice ? parseFloat(body.offerPrice) : null,
      message: body.message || null,
    },
  });

  // Update trade request with latest offer if counter_offer
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = {
    round: { increment: 1 },
    lastReplyBy: replyBy,
  };

  if (replyType === "counter_offer") {
    if (body.offerPrice) updateData.offerPrice = parseFloat(body.offerPrice);
    if (body.offerSwapBrand) updateData.offerSwapBrand = body.offerSwapBrand;
    if (body.offerSwapType) updateData.offerSwapType = body.offerSwapType;
    if (body.offerSwapYear) updateData.offerSwapYear = parseInt(body.offerSwapYear, 10);
    if (body.offerSwapSpec) updateData.offerSwapSpec = body.offerSwapSpec;
    if (body.offerSwapWeight) updateData.offerSwapWeight = parseInt(body.offerSwapWeight, 10);
    if (body.offerSwapDesc) updateData.offerSwapDesc = body.offerSwapDesc;
  }

  await prisma.tradeRequest.update({
    where: { id },
    data: updateData,
  });

  return NextResponse.json(reply, { status: 201 });
}
