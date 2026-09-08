import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  const { searchParams } = req.nextUrl;
  const keyword = searchParams.get("keyword");
  const level = searchParams.get("level");
  const banStatus = searchParams.get("banStatus");
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20", 10)));

  const where: Record<string, unknown> = {};
  if (keyword) {
    const isUidSearch = /^\d+$/.test(keyword);
    where.OR = [
      { username: { contains: keyword, mode: "insensitive" } },
      { email: { contains: keyword, mode: "insensitive" } },
      ...(isUidSearch ? [{ uid: parseInt(keyword, 10) }] : []),
    ];
  }
  if (level) where.level = parseInt(level, 10);
  if (banStatus) where.banStatus = banStatus;

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true, uid: true, username: true, email: true, avatar: true,
        level: true, karma: true, creditScore: true, noShowCount: true,
        followerCount: true, onlineStatus: true, banStatus: true,
        muteStatus: true, mutedUntil: true, warningCount: true,
        createdAt: true,
        _count: { select: { articles: true, comments: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  return Response.json({
    users: users.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() })),
    total, page, limit,
  });
}
