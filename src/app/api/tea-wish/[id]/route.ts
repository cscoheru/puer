import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface RouteProps {
  params: Promise<{ id: string }>;
}

export async function PUT(req: NextRequest, { params }: RouteProps) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const existing = await prisma.teaWishItem.findUnique({ where: { id } });
  if (!existing || existing.status === "deleted") {
    return NextResponse.json({ error: "未找到" }, { status: 404 });
  }
  if (existing.userId !== session.user.id) {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  const body = await req.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: Record<string, any> = {};
  if (body.brand !== undefined) data.brand = body.brand || null;
  if (body.type !== undefined) data.type = body.type || null;
  if (body.year !== undefined) data.year = body.year ? parseInt(body.year, 10) : null;
  if (body.spec !== undefined) data.spec = body.spec || null;
  if (body.acquisitionType !== undefined) data.acquisitionType = body.acquisitionType;
  if (body.swapOfferBrand !== undefined) data.swapOfferBrand = body.swapOfferBrand || null;
  if (body.swapOfferType !== undefined) data.swapOfferType = body.swapOfferType || null;
  if (body.swapOfferYear !== undefined) data.swapOfferYear = body.swapOfferYear ? parseInt(body.swapOfferYear, 10) : null;
  if (body.swapOfferSpec !== undefined) data.swapOfferSpec = body.swapOfferSpec || null;
  if (body.swapOfferWeight !== undefined) data.swapOfferWeight = body.swapOfferWeight ? parseInt(body.swapOfferWeight, 10) : null;
  if (body.swapOfferDesc !== undefined) data.swapOfferDesc = body.swapOfferDesc || null;
  if (body.offerPrice !== undefined) data.offerPrice = body.offerPrice ? parseFloat(body.offerPrice) : null;
  if (body.images !== undefined) data.images = Array.isArray(body.images) ? body.images : [];
  if (body.description !== undefined) data.description = body.description || null;

  const item = await prisma.teaWishItem.update({ where: { id }, data });
  return NextResponse.json(item);
}

export async function DELETE(_req: NextRequest, { params }: RouteProps) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const existing = await prisma.teaWishItem.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "未找到" }, { status: 404 });
  }
  if (existing.userId !== session.user.id) {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  await prisma.teaWishItem.update({ where: { id }, data: { status: "deleted" } });
  return NextResponse.json({ success: true });
}
