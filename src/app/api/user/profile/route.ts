import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const profileSchema = z.object({
  username: z.string().min(2).max(50).optional(),
  nickname: z.string().max(50).nullable().optional(),
  avatar: z.string().max(500).optional().nullable(),
  bio: z.string().max(500).optional().nullable(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, username: true, nickname: true, avatar: true, bio: true, email: true, level: true, registrationRegion: true },
  });
  if (!user) {
    return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  }

  return NextResponse.json(user);
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const body = await req.json();
  const data = profileSchema.parse(body);

  // Check username uniqueness if changing
  if (data.username) {
    const existing = await prisma.user.findUnique({ where: { username: data.username } });
    if (existing && existing.id !== session.user.id) {
      return NextResponse.json({ error: "用户名已被使用" }, { status: 409 });
    }
  }

  const user = await prisma.user.update({
    where: { id: session.user.id },
    data,
    select: { id: true, username: true, nickname: true, avatar: true, bio: true, level: true },
  });

  return NextResponse.json(user);
}
