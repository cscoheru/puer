import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (session?.user?.role !== "admin") {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  const body = await req.json();
  const { action, role } = body; // action: "approve" | "reject" | "set_role"

  if (action === "set_role") {
    if (!["moderator", "deputy"].includes(role)) {
      return NextResponse.json({ error: "角色无效" }, { status: 400 });
    }
    const updated = await prisma.boardModerator.update({
      where: { id },
      data: { role },
    });
    return NextResponse.json(updated);
  }

  if (!["approve", "reject"].includes(action)) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const mod = await prisma.boardModerator.findUnique({ where: { id } });
  if (!mod || mod.status !== "pending") {
    return NextResponse.json({ error: "申请不存在或已处理" }, { status: 404 });
  }

  const updated = await prisma.boardModerator.update({
    where: { id },
    data: {
      status: action === "approve" ? "approved" : "rejected",
      approvedAt: action === "approve" ? new Date() : null,
      approvedBy: action === "approve" ? session.user.id : null,
      role: action === "approve" ? (role || "moderator") : undefined,
    },
  });

  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (session?.user?.role !== "admin") {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  await prisma.boardModerator.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
