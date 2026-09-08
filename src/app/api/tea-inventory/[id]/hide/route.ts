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

  const existing = await prisma.teaInventoryItem.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "未找到" }, { status: 404 });
  }
  if (existing.userId !== session.user.id) {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  const item = await prisma.teaInventoryItem.update({
    where: { id },
    data: { hidden: !existing.hidden },
  });

  return NextResponse.json({ success: true, hidden: item.hidden });
}
