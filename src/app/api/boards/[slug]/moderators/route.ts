import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const moderators = await prisma.boardModerator.findMany({
    where: {
      board: { slug },
      status: "approved",
    },
    include: {
      user: {
        select: { id: true, username: true, nickname: true, avatar: true, level: true },
      },
    },
    orderBy: { approvedAt: "asc" },
  });

  return NextResponse.json(moderators);
}
