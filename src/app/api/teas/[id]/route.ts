import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const teaSchema = z.object({
  name: z.string().min(1).max(200),
  brand: z.string().min(1).max(100),
  year: z.number().int().min(1900).max(2100),
  batch: z.string().max(50).optional().nullable(),
  type: z.enum(["raw", "ripe"]),
  originRegion: z.string().max(100).optional().nullable(),
  weightSpec: z.string().max(50).optional().nullable(),
  storageCondition: z.string().max(100).optional().nullable(),
  coverImage: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
});

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const tea = await prisma.tea.findUnique({
    where: { id },
    include: { _count: { select: { articles: true } } },
  });
  if (!tea) {
    return NextResponse.json({ error: "茶品不存在" }, { status: 404 });
  }

  return NextResponse.json(tea);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.level < 2) {
    return NextResponse.json({ error: "需要Lv.2茶人及以上才能编辑茶品百科" }, { status: 403 });
  }

  const { id } = await params;

  const existing = await prisma.tea.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "茶品不存在" }, { status: 404 });
  }

  const body = await req.json();
  const data = teaSchema.parse(body);

  const tea = await prisma.tea.update({
    where: { id },
    data,
  });

  return NextResponse.json(tea);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可删除茶品" }, { status: 403 });
  }

  const { id } = await params;

  const existing = await prisma.tea.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "茶品不存在" }, { status: 404 });
  }

  await prisma.tea.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
