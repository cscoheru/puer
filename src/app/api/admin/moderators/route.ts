import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

export async function GET() {
  const session = await auth();
  if (session?.user?.role !== "admin") {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  const applications = await prisma.boardModerator.findMany({
    orderBy: { appliedAt: "desc" },
    include: {
      board: { select: { id: true, name: true, slug: true } },
      user: { select: { id: true, username: true, nickname: true, avatar: true, level: true } },
    },
  });

  return NextResponse.json(applications);
}
