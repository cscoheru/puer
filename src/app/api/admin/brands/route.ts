import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/** P2-R14 品牌主数据 CRUD。
 *  品牌是实体：先有品牌，茶品通过 teas.brand 字符串唯一隶属一个品牌。
 *  - GET    品牌列表（含各品牌茶品数）
 *  - POST   创建品牌
 *  - PATCH  改名/改资料——事务同步：brands.name + 全部 teas.brand + brand_bars.brands 数组
 *  - DELETE 删除品牌（仅允许无茶品的品牌；同时从品牌吧中移除该品牌名） */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可访问" }, { status: 403 });
  }
  const [brands, counts] = await Promise.all([
    prisma.brand.findMany({ orderBy: { name: "asc" } }),
    prisma.tea.groupBy({ by: ["brand"], _count: { _all: true } }),
  ]);
  const countMap = new Map(counts.map((c) => [c.brand, c._count._all]));
  return NextResponse.json({
    brands: brands.map((b) => ({ ...b, teaCount: countMap.get(b.name) || 0 })),
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }
  const { name, description, icon } = await req.json();
  const n = typeof name === "string" ? name.trim().slice(0, 100) : "";
  if (!n) return NextResponse.json({ error: "品牌名不能为空" }, { status: 400 });
  try {
    const brand = await prisma.brand.create({
      data: { name: n, description: description?.trim()?.slice(0, 500) || null, icon: icon?.trim()?.slice(0, 10) || null },
    });
    return NextResponse.json({ success: true, brand });
  } catch {
    return NextResponse.json({ error: "品牌已存在" }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }
  const { id, name, description, icon } = await req.json();
  if (!id || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "缺少参数" }, { status: 400 });
  }
  const old = await prisma.brand.findUnique({ where: { id } });
  if (!old) return NextResponse.json({ error: "品牌不存在" }, { status: 404 });
  const newName = name.trim().slice(0, 100);

  const dupe = await prisma.brand.findUnique({ where: { name: newName } });
  if (dupe && dupe.id !== id) {
    return NextResponse.json({ error: `品牌「${newName}」已存在` }, { status: 400 });
  }

  if (old.name === newName) {
    // 仅改资料
    await prisma.brand.update({
      where: { id },
      data: { description: description?.trim()?.slice(0, 500) || null, icon: icon?.trim()?.slice(0, 10) || null },
    });
    return NextResponse.json({ success: true, renamed: false });
  }

  // 改名：一处改名全局生效（品牌行 + 茶品归属 + 品牌吧配置）
  const bars = await prisma.brandBar.findMany({ where: { brands: { has: old.name } } });
  await prisma.$transaction([
    prisma.brand.update({
      where: { id },
      data: { name: newName, description: description?.trim()?.slice(0, 500) || null, icon: icon?.trim()?.slice(0, 10) || null },
    }),
    prisma.tea.updateMany({ where: { brand: old.name }, data: { brand: newName } }),
    ...bars.map((b) =>
      prisma.brandBar.update({
        where: { id: b.id },
        data: { brands: b.brands.map((x) => (x === old.name ? newName : x)) },
      }),
    ),
  ]);

  return NextResponse.json({ success: true, renamed: true, from: old.name, to: newName });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  const brand = await prisma.brand.findUnique({ where: { id } });
  if (!brand) return NextResponse.json({ error: "品牌不存在" }, { status: 404 });

  const teaCount = await prisma.tea.count({ where: { brand: brand.name } });
  if (teaCount > 0) {
    return NextResponse.json({ error: `该品牌下还有 ${teaCount} 款茶品，请先移出` }, { status: 400 });
  }
  // 从品牌吧配置中移除该品牌名
  const bars = await prisma.brandBar.findMany({ where: { brands: { has: brand.name } } });
  await prisma.$transaction([
    ...bars.map((b) =>
      prisma.brandBar.update({
        where: { id: b.id },
        data: { brands: b.brands.filter((x) => x !== brand.name) },
      }),
    ),
    prisma.brand.delete({ where: { id } }),
  ]);
  return NextResponse.json({ success: true });
}
