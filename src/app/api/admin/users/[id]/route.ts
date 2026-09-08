import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin();
  if (error) return error;
  const { id } = await params;

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true, uid: true, username: true, email: true, avatar: true, bio: true,
      level: true, karma: true, creditScore: true, noShowCount: true,
      followerCount: true, followingCount: true, onlineStatus: true,
      banStatus: true, bannedAt: true, banReason: true, role: true,
      createdAt: true, registrationIp: true, registrationRegion: true,
      _count: { select: { articles: true, comments: true, teaSessions: true, actions: true } },
    },
  });

  if (!user) return Response.json({ error: "用户不存在" }, { status: 404 });
  return Response.json({ ...user, createdAt: user.createdAt.toISOString(), bannedAt: user.bannedAt?.toISOString() ?? null });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin();
  if (error) return error;
  const { id } = await params;

  const body = await req.json();
  const data: Record<string, unknown> = {};

  if (typeof body.level === "number") data.level = body.level;
  if (typeof body.karma === "number") data.karma = body.karma;
  if (typeof body.creditScore === "number") data.creditScore = body.creditScore;
  if (body.banStatus === "banned") {
    data.banStatus = "banned";
    data.bannedAt = new Date();
    data.banReason = body.banReason || "管理员封禁";
  } else if (body.banStatus === "active") {
    data.banStatus = "active";
    data.bannedAt = null;
    data.banReason = null;
  }

  const user = await prisma.user.update({ where: { id }, data });
  return Response.json({ ok: true });
}
