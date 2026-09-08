import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/favorites?articleId=xxx - 查是否收藏（需登录）
// GET /api/favorites?userId=xxx - 查用户收藏列表
export async function GET(req: NextRequest) {
  const session = await auth();
  const { searchParams } = new URL(req.url);
  const articleId = searchParams.get("articleId");
  const userId = searchParams.get("userId");

  // 查是否收藏
  if (articleId) {
    if (!session?.user) return NextResponse.json({ favorited: false });
    const fav = await prisma.favorite.findUnique({
      where: { userId_articleId: { userId: session.user.id, articleId } },
    });
    return NextResponse.json({ favorited: !!fav });
  }

  // 查用户收藏列表
  if (userId) {
    const favorites = await prisma.favorite.findMany({
      where: { userId },
      include: {
        article: {
          include: {
            author: { select: { id: true, username: true, avatar: true, level: true } },
            tea: { select: { id: true, name: true, brand: true, year: true } },
            _count: { select: { comments: true, likes: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(favorites);
  }

  return NextResponse.json({ error: "参数不完整" }, { status: 400 });
}

// POST /api/favorites - 切换收藏
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { articleId } = await req.json();
  if (!articleId) {
    return NextResponse.json({ error: "参数不完整" }, { status: 400 });
  }

  const existing = await prisma.favorite.findUnique({
    where: { userId_articleId: { userId: session.user.id, articleId } },
  });

  if (existing) {
    await prisma.favorite.delete({ where: { id: existing.id } });
    return NextResponse.json({ favorited: false });
  }

  await prisma.favorite.create({
    data: { userId: session.user.id, articleId },
  });

  return NextResponse.json({ favorited: true });
}
