import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface BarInput {
  id?: string; // 有 id = 更新，无 id = 新建
  key?: string;
  label: string;
  icon?: string;
  brands: string[];
  sortOrder?: number;
}

/** P2-R13 品牌吧管理：GET 列表 / POST 保存（新建或更新）/ DELETE 删除。
 *  未归入任何吧的品牌自动进「其他吧」（classics 页逻辑）。 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可访问" }, { status: 403 });
  }
  const bars = await prisma.brandBar.findMany({ orderBy: { sortOrder: "asc" } });
  return NextResponse.json({ bars });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }

  const body = (await req.json()) as BarInput;
  const { id, key, label, icon, brands, sortOrder } = body;
  if (!label?.trim() || !Array.isArray(brands)) {
    return NextResponse.json({ error: "缺少参数（label + brands 数组）" }, { status: 400 });
  }
  const cleanBrands = brands.map((b) => String(b).trim()).filter(Boolean);
  if (cleanBrands.length === 0) {
    return NextResponse.json({ error: "至少需要一个品牌" }, { status: 400 });
  }

  try {
    const bar = id
      ? await prisma.brandBar.update({
          where: { id },
          data: {
            label: label.trim().slice(0, 50),
            icon: icon?.trim().slice(0, 10) || null,
            brands: cleanBrands,
            ...(typeof sortOrder === "number" ? { sortOrder } : {}),
          },
        })
      : await prisma.brandBar.create({
          data: {
            key: (key?.trim() || label.trim()).slice(0, 50),
            label: label.trim().slice(0, 50),
            icon: icon?.trim().slice(0, 10) || null,
            brands: cleanBrands,
            sortOrder: typeof sortOrder === "number" ? sortOrder : 99,
          },
        });
    return NextResponse.json({ success: true, bar });
  } catch (e) {
    const msg = e instanceof Error && e.message.includes("Unique") ? "吧 key 已存在" : "保存失败";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可操作" }, { status: 403 });
  }
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  await prisma.brandBar.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
