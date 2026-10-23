import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin-auth";
import { readJsonBody } from "@/lib/cellar-api";
import { reviewTeaRequestSchema, zodMessage } from "@/lib/cellar-schemas";
import { listTeaRequests, reviewTeaRequest } from "@/lib/cellar-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/cellar/requests —— 待审核的自建茶品申请。
 *
 * 后台接口，用 403 语义（`requirePermission`）—— 没权限不是「没登录」。
 *
 * **不受 feature flag 门禁**：flag 关的是「用户能不能用茶仓」，不是
 * 「站长还能不能干活」。前台关了但队列里还有待审核的申请时，站长仍然
 * 要能处理 —— 否则关了功能就等于把待办冻住。
 */
export async function GET(req: NextRequest) {
  const { error } = await requirePermission("cellar:manage");
  if (error) return error;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || "pending";
  const page = Math.max(1, Number(searchParams.get("page") || "1"));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") || "20")));

  const { rows, total } = await listTeaRequests({ status, page, limit });
  return NextResponse.json({ rows, total, page, limit });
}

/**
 * PATCH /api/admin/cellar/requests —— 审核一条申请。
 *
 * body: { id, action: "approve" | "reject", mergedTeaId?, rejectReason? }
 *
 * 通过时必须给 `mergedTeaId`（并入哪款茶）。并入后，引用这条申请的
 * 茶仓条目会自动挂上那款茶 —— 用户加的茶终于能对照站长线了。
 */
export async function PATCH(req: NextRequest) {
  const { session, error } = await requirePermission("cellar:manage");
  if (error) return error;

  const { body, error: bodyError } = await readJsonBody(req);
  if (bodyError) return bodyError;

  const raw = body as { id?: unknown; action?: unknown; mergedTeaId?: unknown; rejectReason?: unknown };
  if (typeof raw.id !== "string" || !raw.id) {
    return NextResponse.json({ error: "缺少申请 id" }, { status: 400 });
  }

  const parsed = reviewTeaRequestSchema.safeParse({
    action: raw.action,
    mergedTeaId: raw.mergedTeaId,
    rejectReason: raw.rejectReason,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }

  const ok = await reviewTeaRequest(
    session!.user.id,
    raw.id,
    parsed.data.action,
    {
      mergedTeaId: parsed.data.mergedTeaId ?? null,
      rejectReason: parsed.data.rejectReason ?? null,
    },
  );
  if (!ok) {
    return NextResponse.json(
      { error: "申请不存在或已被审核过" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
