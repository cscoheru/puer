import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");

  if (!userId) {
    return NextResponse.json({ error: "需要 userId 参数" }, { status: 400 });
  }

  const items = await prisma.teaWishItem.findMany({
    where: { userId, status: "active" },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ data: items });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const body = await req.json();
  const {
    brand, type, year, spec,
    acquisitionType,
    swapOfferBrand, swapOfferType, swapOfferYear, swapOfferSpec, swapOfferWeight, swapOfferDesc,
    offerPrice,
    images,
    description,
  } = body;

  if (!acquisitionType) {
    return NextResponse.json({ error: "请选择获取方式" }, { status: 400 });
  }
  if (acquisitionType === "purchase" && !offerPrice) {
    return NextResponse.json({ error: "请填写出价" }, { status: 400 });
  }
  if (acquisitionType === "swap" && !swapOfferBrand) {
    return NextResponse.json({ error: "请填写置换茶品信息" }, { status: 400 });
  }

  const item = await prisma.teaWishItem.create({
    data: {
      userId: session.user.id,
      brand: brand || null,
      type: type || null,
      year: year ? parseInt(year, 10) : null,
      spec: spec || null,
      acquisitionType,
      swapOfferBrand: swapOfferBrand || null,
      swapOfferType: swapOfferType || null,
      swapOfferYear: swapOfferYear ? parseInt(swapOfferYear, 10) : null,
      swapOfferSpec: swapOfferSpec || null,
      swapOfferWeight: swapOfferWeight ? parseInt(swapOfferWeight, 10) : null,
      swapOfferDesc: swapOfferDesc || null,
      offerPrice: offerPrice ? parseFloat(offerPrice) : null,
      images: Array.isArray(images) ? images : [],
      description: description || null,
    },
  });

  return NextResponse.json(item, { status: 201 });
}
