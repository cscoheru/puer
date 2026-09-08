import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";

/** Composite action: delete reported content + mark report as actioned */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin();
  if (error) return error;
  const { id } = await params;

  const report = await prisma.report.findUnique({ where: { id } });
  if (!report) return Response.json({ error: "举报不存在" }, { status: 404 });

  const body = await req.json();
  const { action } = body;

  if (action === "delete_content") {
    if (report.targetType === "article") {
      await prisma.article.delete({ where: { id: report.targetId } }).catch(() => {});
    } else if (report.targetType === "comment") {
      await prisma.comment.delete({ where: { id: report.targetId } }).catch(() => {});
    }
    await prisma.report.update({
      where: { id },
      data: { status: "actioned", handledBy: session!.user.id, handledAt: new Date(), adminNote: "内容已删除" },
    });
  } else if (action === "ban_user") {
    await prisma.user.update({
      where: { id: report.targetId },
      data: { banStatus: "banned", bannedAt: new Date(), banReason: `违规: ${report.reason}` },
    });
    await prisma.report.update({
      where: { id },
      data: { status: "actioned", handledBy: session!.user.id, handledAt: new Date(), adminNote: "用户已封禁" },
    });
  }

  return Response.json({ ok: true });
}
