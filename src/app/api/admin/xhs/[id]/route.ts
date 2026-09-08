import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";
import { z } from "zod";

const schema = z.object({ status: z.enum(["pending", "posted"]) });

// PATCH /api/admin/xhs/[id] {status}: 标记发布包为已发(pending → posted)。
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error } = await requireAdmin();
  if (error) return error;

  const { id } = await params;
  const body = await req.json();
  const { status } = schema.parse(body);

  const updated = await prisma.xhsPackage.update({
    where: { id },
    data: { status },
  });

  return NextResponse.json(updated);
}
