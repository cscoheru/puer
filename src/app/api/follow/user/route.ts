import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { userId: targetId } = await req.json();
  if (!targetId) {
    return NextResponse.json({ error: "缺少 userId" }, { status: 400 });
  }

  const followerId = session.user.id;
  if (followerId === targetId) {
    return NextResponse.json({ error: "不能关注自己" }, { status: 400 });
  }

  // Toggle follow
  const existing = await prisma.userFollow.findUnique({
    where: { followerId_followingId: { followerId, followingId: targetId } },
  });

  if (existing) {
    await prisma.userFollow.delete({ where: { id: existing.id } });
    // Update cached counts
    await prisma.user.update({ where: { id: followerId }, data: { followingCount: { decrement: 1 } } });
    await prisma.user.update({ where: { id: targetId }, data: { followerCount: { decrement: 1 } } });
    return NextResponse.json({ following: false });
  }

  await prisma.userFollow.create({
    data: { followerId, followingId: targetId },
  });

  // Update cached counts
  await prisma.user.update({ where: { id: followerId }, data: { followingCount: { increment: 1 } } });
  await prisma.user.update({ where: { id: targetId }, data: { followerCount: { increment: 1 } } });

  return NextResponse.json({ following: true });
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const targetId = searchParams.get("userId");

  if (targetId) {
    const follow = await prisma.userFollow.findUnique({
      where: { followerId_followingId: { followerId: session.user.id, followingId: targetId } },
    });
    return NextResponse.json({ following: !!follow });
  }

  // Return all followed user IDs
  const follows = await prisma.userFollow.findMany({
    where: { followerId: session.user.id },
    select: { followingId: true },
  });
  return NextResponse.json({ userIds: follows.map((f) => f.followingId) });
}
