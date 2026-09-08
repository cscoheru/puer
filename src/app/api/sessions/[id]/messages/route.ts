import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = req.nextUrl;
  const after = searchParams.get("after");
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50", 10)));

  const where: Record<string, unknown> = { sessionId: id };
  if (after) {
    where.createdAt = { gt: new Date(after) };
  }

  const messages = await prisma.teaSessionMessage.findMany({
    where,
    include: {
      user: { select: { id: true, username: true, avatar: true, level: true } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const total = await prisma.teaSessionMessage.count({ where: { sessionId: id } });

  return Response.json({ messages, total });
}
