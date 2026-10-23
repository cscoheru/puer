import { NextRequest, NextResponse } from "next/server";
import {
  cellarDisabledResponse,
  cellarEnabled,
  cellarRateLimit,
  readJsonBody,
  resolveCellarActor,
} from "@/lib/cellar-api";
import { updateCellarItemSchema, zodMessage } from "@/lib/cellar-schemas";
import { deleteCellarItem, getCellarItem, updateCellarItem } from "@/lib/cellar-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/cellar/[id] —— 条目详情（仓储期 + 我的品鉴线）。
 *
 * 别人的条目取不到：数据层的 `where` 里带 userId，拿到的是 null → 404。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!cellarEnabled()) return cellarDisabledResponse();

  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const { actor, error } = await resolveCellarActor(
    req,
    searchParams.get("targetUserId"),
  );
  if (error) return error;

  const limited = cellarRateLimit(req, actor!.ownerId, "read", actor!.isProxy);
  if (limited) return limited;

  const item = await getCellarItem(actor!.ownerId, id);
  if (!item) {
    return NextResponse.json({ error: "条目不存在" }, { status: 404 });
  }
  return NextResponse.json(item);
}

/** PATCH /api/cellar/[id] —— 改条目（名字、入仓时间、备注、提醒间隔）。 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!cellarEnabled()) return cellarDisabledResponse();

  const { id } = await params;
  const { body, error: bodyError } = await readJsonBody(req);
  if (bodyError) return bodyError;

  const parsed = updateCellarItemSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }

  const { actor, error } = await resolveCellarActor(req);
  if (error) return error;

  const limited = cellarRateLimit(req, actor!.ownerId, "write", actor!.isProxy);
  if (limited) return limited;

  const d = parsed.data;
  const ok = await updateCellarItem(actor!.ownerId, id, {
    ...("name" in d ? { name: d.name ?? null } : {}),
    ...("acquiredAt" in d
      ? { acquiredAt: d.acquiredAt ? new Date(d.acquiredAt) : null }
      : {}),
    ...("qtyNote" in d ? { qtyNote: d.qtyNote ?? null } : {}),
    ...("remindEveryMonths" in d
      ? { remindEveryMonths: d.remindEveryMonths }
      : {}),
    ...("nextRemindAt" in d
      ? { nextRemindAt: d.nextRemindAt ? new Date(d.nextRemindAt) : null }
      : {}),
  });

  if (!ok) {
    return NextResponse.json({ error: "条目不存在" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/cellar/[id] —— 删条目。
 *
 * 品鉴记录与仓储期随条目级联删除（DB 里是 ON DELETE CASCADE）。
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!cellarEnabled()) return cellarDisabledResponse();

  const { id } = await params;
  const { actor, error } = await resolveCellarActor(req);
  if (error) return error;

  const limited = cellarRateLimit(req, actor!.ownerId, "write", actor!.isProxy);
  if (limited) return limited;

  const ok = await deleteCellarItem(actor!.ownerId, id);
  if (!ok) {
    return NextResponse.json({ error: "条目不存在" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
