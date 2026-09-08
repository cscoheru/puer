import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");
  const showHidden = searchParams.get("showHidden") === "true";
  const brand = searchParams.get("brand");
  const type = searchParams.get("type");
  const yearFrom = searchParams.get("yearFrom");
  const yearTo = searchParams.get("yearTo");
  const storage = searchParams.get("storage");
  const spec = searchParams.get("spec");
  const sort = searchParams.get("sort") || "newest";
  const page = parseInt(searchParams.get("page") || "1", 10);
  const limit = parseInt(searchParams.get("limit") || "20", 10);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { status: "active" };

  // Use showHidden only when the requester owns the inventory
  if (showHidden && userId) {
    const session = await auth();
    if (session?.user?.id === userId) {
      // Owner requesting hidden items — skip hidden: false filter
    } else {
      where.hidden = false;
    }
  } else {
    where.hidden = false;
  }

  if (userId) where.userId = userId;
  // Exclude expired items for non-owners (exchange hall)
  if (!userId) {
    where.OR = [
      { expiresAt: null },
      { expiresAt: { gt: new Date() } },
    ];
  }
  if (brand) where.brand = { contains: brand, mode: "insensitive" };
  if (type) where.type = type;
  if (storage) where.storage = storage;
  if (spec) where.spec = spec;
  if (yearFrom || yearTo) {
    where.year = {};
    if (yearFrom) where.year.gte = parseInt(yearFrom, 10);
    if (yearTo) where.year.lte = parseInt(yearTo, 10);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orderBy: any =
    sort === "popular" ? { requestCount: "desc" as const } : { createdAt: "desc" as const };

  const [items, total] = await Promise.all([
    prisma.teaInventoryItem.findMany({
      where,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
      include: {
        user: { select: { id: true, username: true, avatar: true, level: true } },
      },
    }),
    prisma.teaInventoryItem.count({ where }),
  ]);

  return NextResponse.json({ data: items, total, page, limit });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const body = await req.json();
  const { brand, name, type, year, spec, remainingWeight, storage, purchaseTime, source, openTime, description, estimatedValue, images, validityDays } = body;

  if (!brand || !year || !spec || !remainingWeight || !storage) {
    return NextResponse.json({ error: "请填写必填字段" }, { status: 400 });
  }

  const expiresAt = validityDays ? new Date(Date.now() + validityDays * 86400000) : null;

  const item = await prisma.teaInventoryItem.create({
    data: {
      userId: session.user.id,
      brand,
      name: name || null,
      type: type || "raw",
      year: parseInt(year, 10),
      spec,
      remainingWeight: parseInt(remainingWeight, 10),
      storage,
      purchaseTime: purchaseTime ? new Date(purchaseTime) : null,
      source: source || null,
      openTime: openTime ? new Date(openTime) : null,
      description: description || null,
      estimatedValue: estimatedValue ? parseFloat(estimatedValue) : null,
      images: images || [],
      validityDays: validityDays || null,
      expiresAt,
    },
  });

  return NextResponse.json(item, { status: 201 });
}
