import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const mods = await prisma.boardModerator.findMany({
    where: { userId: session.user.id, status: "approved" },
    include: {
      board: { select: { id: true, name: true, slug: true } },
    },
  });

  return NextResponse.json(mods);
}
