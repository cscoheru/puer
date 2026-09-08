import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

/** Public report endpoint — any logged-in user can submit */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }

  const { targetType, targetId, reason } = await req.json();
  if (!targetType || !targetId || !reason) {
    return Response.json({ error: "参数不完整" }, { status: 400 });
  }
  if (!["article", "comment", "user", "session"].includes(targetType)) {
    return Response.json({ error: "举报类型无效" }, { status: 400 });
  }

  // Rate limit: max 5 reports per user per hour
  const oneHourAgo = new Date(Date.now() - 3600000);
  const recentCount = await prisma.report.count({
    where: { reporterId: session.user.id, createdAt: { gte: oneHourAgo } },
  });
  if (recentCount >= 5) {
    return Response.json({ error: "举报过于频繁，请稍后再试" }, { status: 429 });
  }

  const report = await prisma.report.create({
    data: {
      reporterId: session.user.id,
      targetType,
      targetId,
      reason,
    },
  });

  return Response.json({ ok: true, id: report.id }, { status: 201 });
}
