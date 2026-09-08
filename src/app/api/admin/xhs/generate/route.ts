import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";
import { generateXhsCopy } from "@/lib/xhs-content";
import { generateXhsVideo } from "@/lib/xhs-video";
import { z } from "zod";

// DeepSeek 文案 + ffmpeg 视频可能各耗时数秒~十数秒,默认 10s 不够。
export const maxDuration = 60;

const schema = z.object({ articleId: z.string().min(1) });

// POST {articleId}: 精华帖 → DeepSeek 钩子文案 → 竖屏视频 → 存 XhsPackage。
// 文案与视频任一失败即抛错返回 500(视频是发布包核心,不静默吞)。
export async function POST(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  const body = await req.json();
  const { articleId } = schema.parse(body);

  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { id: true, title: true, content: true, images: true },
  });
  if (!article) {
    return NextResponse.json({ error: "帖子不存在" }, { status: 404 });
  }
  if (!article.images.length) {
    return NextResponse.json({ error: "该帖无图片,无法生成视频" }, { status: 400 });
  }

  // 应用层先查,给清晰 409;数据库 articleId @unique 兜底并发竞态
  const existing = await prisma.xhsPackage.findUnique({ where: { articleId } });
  if (existing) {
    return NextResponse.json({ error: "该帖已生成过发布包" }, { status: 409 });
  }

  const copy = await generateXhsCopy(article.title, article.content);
  const videoUrl = await generateXhsVideo(article.images[0], copy.hookTitle);

  const pkg = await prisma.xhsPackage.create({
    data: {
      articleId,
      videoUrl,
      hookTitle: copy.hookTitle,
      caption: copy.caption,
      tags: copy.tags,
      status: "pending",
    },
    include: { article: { select: { id: true, title: true } } },
  });

  return NextResponse.json(pkg, { status: 201 });
}
