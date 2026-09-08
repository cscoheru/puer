import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

export async function PUT(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const message = await prisma.userMessage.findUnique({ where: { id } });
  if (!message || message.receiverId !== session.user.id) {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  await prisma.userMessage.update({
    where: { id },
    data: { readAt: new Date() },
  });

  return NextResponse.json({ success: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const message = await prisma.userMessage.findUnique({ where: { id } });
  if (!message || (message.senderId !== session.user.id && message.receiverId !== session.user.id)) {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  await prisma.userMessage.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
