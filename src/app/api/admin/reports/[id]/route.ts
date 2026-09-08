import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin();
  if (error) return error;
  const { id } = await params;

  const body = await req.json();
  const { action, adminNote } = body;
  // action: "dismiss" | "warning" | "mute" | "ban"
  // muteDays: number (required when action=mute)
  // targetUserId: string (required for penalty application)

  const report = await prisma.report.findUnique({ where: { id } });
  if (!report) return Response.json({ error: "举报不存在" }, { status: 404 });
  if (report.status !== "pending") return Response.json({ error: "该举报已处理" }, { status: 400 });

  // Update report
  const reportUpdate: Record<string, unknown> = {
    handledBy: session!.user.id,
    handledAt: new Date(),
    adminNote: adminNote || null,
  };

  if (action === "dismiss") {
    reportUpdate.status = "dismissed";
    reportUpdate.penalty = null;

    await prisma.report.update({ where: { id }, data: reportUpdate });

    // Notify reporter: dismissed but thanks
    await prisma.notification.create({
      data: {
        userId: report.reporterId,
        type: "system",
        content: `您提交的举报已收到，经查实该内容暂未违反社区规范。感谢您的监督，我们会持续关注社区秩序。`,
        link: null,
      },
    });

    return Response.json({ ok: true, action: "dismissed" });
  }

  // actioned penalties
  reportUpdate.status = "actioned";

  let targetUserId = body.targetUserId as string | undefined;
  if (!targetUserId && report.targetType === "user") {
    targetUserId = report.targetId;
  } else if (!targetUserId) {
    // For article/comment targets, find the author
    if (report.targetType === "article") {
      const article = await prisma.article.findUnique({ where: { id: report.targetId }, select: { authorId: true } });
      targetUserId = article?.authorId;
    } else if (report.targetType === "comment") {
      const comment = await prisma.comment.findUnique({ where: { id: report.targetId }, select: { authorId: true } });
      targetUserId = comment?.authorId;
    }
  }

  if (!targetUserId) {
    return Response.json({ error: "无法确定被举报用户" }, { status: 400 });
  }

  if (action === "warning") {
    reportUpdate.penalty = "warning";

    await prisma.$transaction([
      prisma.report.update({ where: { id }, data: reportUpdate }),
      prisma.user.update({
        where: { id: targetUserId },
        data: { warningCount: { increment: 1 } },
      }),
    ]);

    // Notify offender
    await prisma.notification.create({
      data: {
        userId: targetUserId,
        type: "system",
        content: `您的内容因"${report.reason}"被社区规范提醒。请留意发帖内容，共同维护社区氛围。违规累计将导致禁言或封禁。`,
        link: report.targetType === "article" ? `/forum/thread/${report.targetId}` : null,
      },
    });

    // Notify reporter
    await prisma.notification.create({
      data: {
        userId: report.reporterId,
        type: "system",
        content: `您举报的内容已查实，我们已对发布者发出警告。感谢您的监督！`,
        link: null,
      },
    });

    return Response.json({ ok: true, action: "warning" });
  }

  if (action === "mute") {
    const muteDays = (body.muteDays as number) || 7;
    const mutedUntil = new Date();
    mutedUntil.setDate(mutedUntil.getDate() + muteDays);

    reportUpdate.penalty = "mute";
    reportUpdate.penaltyDuration = muteDays;

    await prisma.$transaction([
      prisma.report.update({ where: { id }, data: reportUpdate }),
      prisma.user.update({
        where: { id: targetUserId },
        data: {
          muteStatus: "muted",
          mutedUntil,
          muteReason: `因"${report.reason}"被禁言${muteDays}天`,
          warningCount: { increment: 1 },
        },
      }),
    ]);

    // Notify offender
    await prisma.notification.create({
      data: {
        userId: targetUserId,
        type: "system",
        content: `您因"${report.reason}"被禁言${muteDays}天，期间不可发帖和回复，但可以浏览内容。禁言将于 ${mutedUntil.toLocaleDateString("zh-CN")} 解除。`,
        link: report.targetType === "article" ? `/forum/thread/${report.targetId}` : null,
      },
    });

    // Notify reporter
    await prisma.notification.create({
      data: {
        userId: report.reporterId,
        type: "system",
        content: `您举报的内容已查实，我们已对发布者处以${muteDays}天禁言。感谢您的监督！`,
        link: null,
      },
    });

    return Response.json({ ok: true, action: "mute", muteDays });
  }

  if (action === "ban") {
    reportUpdate.penalty = "ban";

    await prisma.$transaction([
      prisma.report.update({ where: { id }, data: reportUpdate }),
      prisma.user.update({
        where: { id: targetUserId },
        data: {
          banStatus: "banned",
          bannedAt: new Date(),
          banReason: `因"${report.reason}"被永久封禁`,
        },
      }),
    ]);

    // Notify reporter (offender won't be able to see notifications since banned)
    await prisma.notification.create({
      data: {
        userId: report.reporterId,
        type: "system",
        content: `您举报的内容已查实，我们已对违规账号进行封禁处理。感谢您的监督！`,
        link: null,
      },
    });

    return Response.json({ ok: true, action: "ban" });
  }

  return Response.json({ error: "未知操作类型" }, { status: 400 });
}
