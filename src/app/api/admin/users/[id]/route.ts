import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requirePermission } from "@/lib/admin-auth";
import { checkRoleChange } from "@/lib/permissions";

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
      isSynthetic: true,
      createdAt: true, registrationIp: true, registrationRegion: true,
      _count: { select: { articles: true, comments: true, teaSessions: true, actions: true } },
    },
  });

  if (!user) return Response.json({ error: "用户不存在" }, { status: 404 });
  return Response.json({ ...user, createdAt: user.createdAt.toISOString(), bannedAt: user.bannedAt?.toISOString() ?? null });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, error } = await requirePermission("admin:users");
  if (error) return error;
  const { id } = await params;

  const body = await req.json();
  const data: Record<string, unknown> = {};

  // 角色变更（PRD §13.4）：权限在界面上可改，不必手写 SQL。
  if (typeof body.role === "string") {
    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true },
    });
    if (!target) return Response.json({ error: "用户不存在" }, { status: 404 });

    const admins = await prisma.user.count({ where: { role: "admin" } });
    const verdict = checkRoleChange(session.user.id, target, body.role, admins);
    if (!verdict.ok) {
      return Response.json({ error: verdict.error }, { status: 400 });
    }
    data.role = body.role;
  }

  if (typeof body.level === "number") data.level = body.level;
  if (typeof body.karma === "number") data.karma = body.karma;
  if (typeof body.creditScore === "number") data.creditScore = body.creditScore;
  // 自动化标记（F0）：打标后该账号进入 cron 池，其行为不计入真人指标。
  if (typeof body.isSynthetic === "boolean") data.isSynthetic = body.isSynthetic;
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
