import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";

// GET: 返回热榜 + 最新「有视频」的帖子,供后台下载工具挑选。
// (原小红书生成管道的 packages/candidates 已废弃,代码保留但不在此返回)
export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;

  const where = {
    videoUrl: { not: null },
    status: "published" as const,
    visibility: "public" as const,
  };

  const [hot, latest] = await Promise.all([
    prisma.article.findMany({
      where,
      orderBy: { upvotes: "desc" },
      take: 20,
      select: {
        id: true,
        title: true,
        videoUrl: true,
        createdAt: true,
        upvotes: true,
        author: { select: { username: true } },
      },
    }),
    prisma.article.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        title: true,
        videoUrl: true,
        createdAt: true,
        upvotes: true,
        author: { select: { username: true } },
      },
    }),
  ]);

  return NextResponse.json({ hot, latest });
}
