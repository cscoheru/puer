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

  const existing = await prisma.teaInventoryItem.findUnique({ where: { id } });
  if (!existing || existing.status === "deleted") {
    return NextResponse.json({ error: "未找到" }, { status: 404 });
  }
  if (existing.userId !== session.user.id && session.user.role !== "admin") {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  const body = await req.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: Record<string, any> = {};
  if (body.brand !== undefined) data.brand = body.brand;
  if (body.name !== undefined) data.name = body.name || null;
  if (body.type !== undefined) data.type = body.type;
  if (body.year !== undefined) data.year = parseInt(body.year, 10);
  if (body.spec !== undefined) data.spec = body.spec;
  if (body.remainingWeight !== undefined) data.remainingWeight = parseInt(body.remainingWeight, 10);
  if (body.storage !== undefined) data.storage = body.storage;
  if (body.purchaseTime !== undefined) data.purchaseTime = body.purchaseTime ? new Date(body.purchaseTime) : null;
  if (body.source !== undefined) data.source = body.source;
  if (body.openTime !== undefined) data.openTime = body.openTime ? new Date(body.openTime) : null;
  if (body.description !== undefined) data.description = body.description;
  if (body.estimatedValue !== undefined) data.estimatedValue = body.estimatedValue ? parseFloat(body.estimatedValue) : null;
  if (body.images !== undefined) data.images = body.images;
  if (body.status !== undefined) data.status = body.status;
  if (body.hidden !== undefined) data.hidden = body.hidden;
  if (body.validityDays !== undefined) {
    data.validityDays = body.validityDays || null;
    data.expiresAt = body.validityDays ? new Date(Date.now() + body.validityDays * 86400000) : null;
  }

  const item = await prisma.teaInventoryItem.update({ where: { id }, data });
  return NextResponse.json(item);
}

export async function DELETE(_req: NextRequest, { params }: RouteProps) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const existing = await prisma.teaInventoryItem.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "未找到" }, { status: 404 });
  }
  if (existing.userId !== session.user.id && session.user.role !== "admin") {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  // Hard delete — remove from database entirely
  await prisma.teaInventoryItem.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
