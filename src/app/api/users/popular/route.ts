import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const users = await prisma.user.findMany({
    where: { role: { not: "admin" } },
    orderBy: { karma: "desc" },
    take: 10,
    select: {
      id: true,
      username: true,
      avatar: true,
      karma: true,
      level: true,
      bio: true,
    },
  });

  return NextResponse.json(users);
}
