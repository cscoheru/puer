import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const sessionUser = await auth();
  if (!sessionUser?.user) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: sessionUser.user.id },
    select: { onlineStatus: true },
  });

  return Response.json({ onlineStatus: user?.onlineStatus || "offline" });
}

export async function PUT(req: NextRequest) {
  const sessionUser = await auth();
  if (!sessionUser?.user) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }

  const body = await req.json();
  const { onlineStatus } = body;
  if (!["online", "offline", "busy"].includes(onlineStatus)) {
    return Response.json({ error: "状态无效" }, { status: 400 });
  }

  await prisma.user.update({
    where: { id: sessionUser.user.id },
    data: { onlineStatus },
  });

  return Response.json({ onlineStatus });
}
