import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin-auth";
import { deletePriceSnapshot } from "@/lib/price-snapshot-data";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/admin/price-snapshots/[id] —— 删掉录错的一条。
 *
 * 快照是「历史事实」，删了就等于说那天没这个行情 —— 所以只在**录错**时用，
 * 而且没有「回收站」（历史要么留着，要么改，不能悄悄消失）。
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { error } = await requirePermission("admin:content");
  if (error) return error;
  const { id } = await params;

  const ok = await deletePriceSnapshot(id);
  if (!ok) {
    return NextResponse.json({ error: "这条快照不存在" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
