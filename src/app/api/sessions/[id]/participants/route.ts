import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const participants = await prisma.sessionParticipant.findMany({
    where: { sessionId: id },
    include: {
      user: { select: { id: true, username: true, avatar: true, level: true, onlineStatus: true } },
    },
    orderBy: { enteredAt: "asc" },
  });

  const onlineCount = participants.filter((p) => !p.leftAt).length;

  return Response.json({ participants, onlineCount, total: participants.length });
}
