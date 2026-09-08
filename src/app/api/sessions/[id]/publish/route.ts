import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { screenContent } from "@/lib/moderation";

export const dynamic = "force-dynamic";

/** Publish ended session as forum article */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionUser = await auth();
  if (!sessionUser?.user) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }

  const session = await prisma.teaSession.findUnique({
    where: { id },
    select: { hostId: true, status: true, title: true, description: true, images: true,
      teaName: true, brewMethod: true, waterTemp: true, teaWeight: true, scheduledAt: true,
      duration: true, startedAt: true, endedAt: true, publishedArticleId: true },
  });
  if (!session) return Response.json({ error: "茶席不存在" }, { status: 404 });
  if (session.hostId !== sessionUser.user.id)
    return Response.json({ error: "只有室主可以发布" }, { status: 403 });
  if (session.status !== "ended")
    return Response.json({ error: "只有已结束的茶席可以发布" }, { status: 400 });
  if (session.publishedArticleId)
    return Response.json({ error: "已发布到论坛" }, { status: 400 });

  // Build article content
  const timeStr = session.scheduledAt
    ? new Date(session.scheduledAt).toLocaleString("zh-CN")
    : "";
  const durationStr = session.duration ? `${session.duration}分钟` : "";
  const brewInfo = [session.teaName, session.brewMethod, session.waterTemp ? `${session.waterTemp}°C` : "", session.teaWeight].filter(Boolean).join(" · ");

  const content = [
    `## 茶会信息`,
    ``,
    `**茶品：** ${session.teaName}`,
    `**时间：** ${timeStr}`,
    durationStr ? `**时长：** ${durationStr}` : "",
    brewInfo ? `**冲泡：** ${brewInfo}` : "",
    ``,
    session.description || "",
    ``,
    `---`,
    `[查看茶会详情](/sessions/${id})`,
  ].filter(Boolean).join("\n");

  // 内容审核:敏感词命中→拒绝;AI 放行→发布;可疑/故障→送审
  const mod = await screenContent(`${session.title} ${session.description || ""}`);
  if (mod.decision === "reject") {
    return Response.json({ error: "内容含违规信息,无法发布" }, { status: 400 });
  }
  const isPublish = mod.decision === "publish";

  const article = await prisma.article.create({
    data: {
      type: "tasting",
      title: `🍵 云喝茶: ${session.title}`,
      content,
      summary: `${session.teaName} · ${timeStr}`,
      status: isPublish ? "published" : "pending_review",
      moderation: isPublish
        ? undefined
        : { decision: mod.decision, categories: mod.categories, confidence: mod.confidence, reason: mod.reason, source: mod.source },
      images: session.images || [],
      authorId: sessionUser.user.id,
    },
  });

  // Link back
  await prisma.teaSession.update({
    where: { id },
    data: { publishedArticleId: article.id },
  });

  return Response.json(article, { status: 201 });
}
