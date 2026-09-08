import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const teaSchema = z.object({
  name: z.string().min(1).max(200),
  brand: z.string().min(1).max(100),
  year: z.number().int().min(1900).max(2100),
  batch: z.string().max(50).optional(),
  type: z.enum(["raw", "ripe"]),
  originRegion: z.string().max(100).optional(),
  weightSpec: z.string().max(50).optional(),
  storageCondition: z.string().max(100).optional(),
  coverImage: z.string().optional(),
  gallery: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const brand = searchParams.get("brand");
  const year = searchParams.get("year");
  const type = searchParams.get("type");
  const search = searchParams.get("q");
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "20");

  const where: Record<string, unknown> = {};
  if (brand) where.brand = brand;
  if (year) where.year = parseInt(year);
  if (type) where.type = type;
  if (search) where.name = { contains: search, mode: "insensitive" };

  const [teas, total] = await Promise.all([
    prisma.tea.findMany({
      where,
      include: {
        _count: { select: { articles: true, tastingNotes: true } },
        user: { select: { username: true } },
      },
      orderBy: [{ tastingNoteCount: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.tea.count({ where }),
  ]);

  return NextResponse.json({ teas, total, page, limit });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.level < 2) {
    return NextResponse.json({ error: "需要Lv.2茶人及以上才能创建茶品百科" }, { status: 403 });
  }

  const body = await req.json();
  const data = teaSchema.parse(body);

  const tea = await prisma.tea.create({
    data: {
      ...data,
      createdBy: session.user.id,
    },
  });

  return NextResponse.json(tea, { status: 201 });
}
