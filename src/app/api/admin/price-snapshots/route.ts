import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin-auth";
import { readJsonBody } from "@/lib/http-body";
import { createPriceSnapshotSchema } from "@/lib/price-snapshot-schemas";
import {
  createPriceSnapshot,
  latestSnapshotDate,
  listAllPriceSnapshots,
  listRecordableTeas,
} from "@/lib/price-snapshot-data";
import { quarterHint } from "@/lib/price-snapshot";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/price-snapshots —— 行情快照的后台数据。
 *
 * 返回两样东西：
 *   - `teas`：可以录入的茶 —— **经典茶 + 出现在任一用户茶仓里的茶**
 *     （PRD F5 的范围原文）；
 *   - `snapshots`：已录的全部快照（按日期倒序）。
 */
export async function GET() {
  const { error } = await requirePermission("admin:content");
  if (error) return error;

  const [teas, snapshots] = await Promise.all([
    listRecordableTeas(),
    listAllPriceSnapshots(),
  ]);

  return NextResponse.json({ teas, snapshots });
}

/**
 * POST /api/admin/price-snapshots —— 录一条价格区间快照。
 *
 * 只录区间不录点值（PRD F5）。「按季度」是**约定不是约束**：距上次不到
 * 90 天时返回一句提醒，但**不拦** —— 站长有理由补录时应该能录。
 */
export async function POST(req: NextRequest) {
  const { session, error } = await requirePermission("admin:content");
  if (error) return error;

  const { body, error: bodyError } = await readJsonBody(req);
  if (bodyError) return bodyError;

  const parsed = createPriceSnapshotSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: issue ? `${issue.path.join(".")}：${issue.message}` : "参数不对" },
      { status: 400 },
    );
  }
  const d = parsed.data;

  const tea = await prisma.tea.findFirst({
    where: { id: d.teaId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!tea) {
    return NextResponse.json({ error: "茶品不存在" }, { status: 404 });
  }

  // 同一天同一条茶已经录过 → 那是「改」，不是「新增」。
  const sameDay = await prisma.priceSnapshot.findFirst({
    where: { teaId: d.teaId, snapshotDate: new Date(`${d.snapshotDate}T00:00:00.000Z`) },
    select: { id: true },
  });
  if (sameDay) {
    return NextResponse.json(
      { error: "这一天已经录过了 —— 要改的话先删掉原来那条" },
      { status: 400 },
    );
  }

  const last = await latestSnapshotDate(d.teaId);
  const hint = quarterHint(last);

  const row = await createPriceSnapshot({
    teaId: d.teaId,
    snapshotDate: d.snapshotDate,
    low: d.low,
    high: d.high,
    currency: d.currency ?? "CNY",
    sourceLabel: d.sourceLabel,
    note: d.note ?? null,
    enteredBy: session?.user?.id ?? null,
  });

  return NextResponse.json({
    ok: true,
    snapshot: row,
    hint: hint.text,
  });
}
