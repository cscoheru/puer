import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin-auth";
import {
  parseMarketPrice,
  suggestRangeFromMarketPrice,
} from "@/lib/price-snapshot";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/price-snapshots/suggest?teaId=xxx —— 按东和行情给一个
 * 价格区间的建议。
 *
 * 站长 2026-10-25：「行情快照中的价格区间，有部分在东和行情中是有的，
 * 上限请参考东和行情，下限为东和行情的 60%。」
 *
 * 所以后台录行情时，表单**预填**一个建议区间：上限 = 东和的价（是区间就取
 * 上限），下限 = 上限的 60%。站长可以改 —— 建议只是建议。
 *
 * 没有东和行情（或只有每克价）→ 不给建议，表单留空。
 */
export async function GET(req: NextRequest) {
  const { error } = await requirePermission("admin:content");
  if (error) return error;

  const teaId = req.nextUrl.searchParams.get("teaId") ?? "";
  if (!teaId) {
    return NextResponse.json({ error: "缺少参数（teaId）" }, { status: 400 });
  }

  const tea = await prisma.tea.findFirst({
    where: { id: teaId, deletedAt: null },
    select: { id: true, name: true, marketInfo: true },
  });
  if (!tea) {
    return NextResponse.json({ error: "茶品不存在" }, { status: 404 });
  }

  const raw =
    tea.marketInfo && typeof tea.marketInfo === "object"
      ? ((tea.marketInfo as { price?: unknown }).price as string | undefined)
      : undefined;
  const parsed = parseMarketPrice(raw);
  const suggestion = suggestRangeFromMarketPrice(raw);

  return NextResponse.json({
    teaId: tea.id,
    teaName: tea.name,
    marketPrice: parsed.raw || null,
    marketPriceKind: parsed.kind,
    suggestion,
  });
}
