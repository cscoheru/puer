import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/cellar/teas?q=xxx —— 审核时搜索「并入哪款茶」。
 *
 * 搜索要同时匹配**名称**和**别名**（`Tea.aliases`）——
 * 用户申请时写的是「班章乔木」，茶品库里可能叫「2005 班章乔木生饼」，
 * 只匹配 name 会让站长以为查不到这款茶。
 */
export async function GET(req: NextRequest) {
  const { error } = await requirePermission("cellar:manage");
  if (error) return error;

  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (!q) return NextResponse.json({ teas: [] });

  const teas = await prisma.tea.findMany({
    where: {
      deletedAt: null,
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { brand: { contains: q, mode: "insensitive" } },
        { aliases: { has: q } },
      ],
    },
    orderBy: [{ isClassic: "desc" }, { tastingNoteCount: "desc" }],
    take: 20,
    select: { id: true, name: true, brand: true, year: true, type: true },
  });

  return NextResponse.json({ teas });
}
