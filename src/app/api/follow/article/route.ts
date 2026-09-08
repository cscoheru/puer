import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { articleId } = await req.json();
  if (!articleId) {
    return NextResponse.json({ error: "缺少 articleId" }, { status: 400 });
  }

  const userId = session.user.id;

  // Toggle follow
  const existing = await prisma.followedArticle.findUnique({
    where: { userId_articleId: { userId, articleId } },
  });

  if (existing) {
    await prisma.followedArticle.delete({ where: { id: existing.id } });
    return NextResponse.json({ following: false });
  }

  await prisma.followedArticle.create({
    data: { userId, articleId },
  });

  return NextResponse.json({ following: true });
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const articleId = searchParams.get("articleId");

  if (articleId) {
    const follow = await prisma.followedArticle.findUnique({
      where: { userId_articleId: { userId: session.user.id, articleId } },
    });
    return NextResponse.json({ following: !!follow });
  }

  // Return all followed article IDs
  const follows = await prisma.followedArticle.findMany({
    where: { userId: session.user.id },
    select: { articleId: true },
  });
  return NextResponse.json({ articleIds: follows.map((f) => f.articleId) });
}
