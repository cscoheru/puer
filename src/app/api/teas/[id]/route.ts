import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { z } from "zod";
import { canViewPendingTea } from "@/lib/tea-tier";

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
  gallery: z.array(z.string()).optional().nullable(),
  description: z.string().optional().nullable(),
  marketInfo: z.record(z.string(), z.unknown()).optional().nullable(),
});

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const tea = await prisma.tea.findFirst({
    where: { id, deletedAt: null },
    include: { _count: { select: { articles: true } } },
  });
  // 茶品库 = 全集：经典茶 JSON 公开；非经典茶 JSON 需登录（与 /tea/[id] 页面闸门一致）
  const session = await auth();
  if (!tea || (tea.isClassic !== true && !session?.user)) {
    return NextResponse.json({ error: "茶品不存在" }, { status: 404 });
  }
  // 「待整理」的茶品：直链进来时，创建者本人与站长看得见；别人是 404
  // —— 不是 403，因为「它存在但你不能看」本身就是信息。
  if (!canViewPendingTea(tea, session?.user ? { id: session.user.id, isAdmin: can(session.user, "admin:access") } : null)) {
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
  const parsed = teaSchema.parse(body);

  // Prisma Json? fields require Prisma.DbNull (not plain null) to clear
  // and InputJsonValue-compatible types for values.
  const data: Record<string, unknown> = { ...parsed };
  if (parsed.marketInfo === null) {
    data.marketInfo = Prisma.DbNull;
  } else if (parsed.marketInfo !== undefined) {
    data.marketInfo = parsed.marketInfo as Prisma.InputJsonValue;
  }
  if (parsed.gallery === null) {
    data.gallery = Prisma.DbNull;
  } else if (parsed.gallery !== undefined) {
    data.gallery = parsed.gallery as Prisma.InputJsonValue;
  }

  const tea = await prisma.tea.update({
    where: { id },
    data,
  });

  return NextResponse.json(tea);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || !can(session.user, "tea:edit")) {
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
