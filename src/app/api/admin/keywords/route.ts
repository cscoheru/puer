import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;

  const keywords = await prisma.sensitiveKeyword.findMany({
    orderBy: { createdAt: "desc" },
  });

  return Response.json({ keywords });
}

export async function POST(req: NextRequest) {
  const { error } = await requireAdmin();
  if (error) return error;

  const { keyword, category } = await req.json();
  if (!keyword) return Response.json({ error: "关键词不能为空" }, { status: 400 });

  const created = await prisma.sensitiveKeyword.create({
    data: { keyword, category: category || "general" },
  });

  return Response.json(created, { status: 201 });
}
