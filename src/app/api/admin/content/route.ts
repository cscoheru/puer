import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

/** Check content against sensitive keywords */
export async function POST(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  const { content } = await req.json();
  if (!content) return Response.json({ error: "缺少内容" }, { status: 400 });

  const keywords = await prisma.sensitiveKeyword.findMany({
    where: { isActive: true },
    select: { keyword: true, category: true },
  });

  const lower = content.toLowerCase();
  const matched = keywords.filter((k) => lower.includes(k.keyword.toLowerCase()));

  return Response.json({ flagged: matched.length > 0, matches: matched });
}
