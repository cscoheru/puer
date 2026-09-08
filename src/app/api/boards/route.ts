import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const boards = await prisma.board.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      _count: { select: { articles: true } },
    },
  });

  return NextResponse.json(boards);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { name, slug, description, icon } = await req.json();
  if (!name?.trim() || !slug?.trim()) {
    return NextResponse.json({ error: "名称和标识不能为空" }, { status: 400 });
  }

  // Check slug uniqueness
  const existing = await prisma.board.findUnique({ where: { slug: slug.trim() } });
  if (existing) {
    return NextResponse.json({ error: "该标识已被使用" }, { status: 409 });
  }

  const maxOrder = await prisma.board.aggregate({ _max: { sortOrder: true } });

  const board = await prisma.board.create({
    data: {
      name: name.trim(),
      slug: slug.trim(),
      description: description?.trim() || null,
      icon: icon?.trim() || null,
      sortOrder: (maxOrder._max.sortOrder || 0) + 1,
    },
  });

  return NextResponse.json(board, { status: 201 });
}
