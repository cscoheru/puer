import { NextRequest, NextResponse } from "next/server";
import {
  cellarDisabledResponse,
  cellarEnabled,
  cellarRateLimit,
  readJsonBody,
  resolveCellarActor,
} from "@/lib/cellar-api";
import { addTastingSchema, zodMessage } from "@/lib/cellar-schemas";
import { addTasting, getCellarItem } from "@/lib/cellar-data";

export const dynamic = "force-dynamic";

/**
 * POST /api/cellar/[id]/tastings —— 记一条品鉴。
 *
 * 快速品鉴的三下点击（比上次 → 阶段 → 保存）打到这里；
 * 四维、描述词、备注、图片、克重、器具都是可选项，不传就留空。
 *
 * `elapsedSeconds` 由前端记录 —— 退出标准要「快速品鉴中位耗时 < 30 秒」，
 * 这个数只能从客户端拿。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!cellarEnabled()) return cellarDisabledResponse();

  const { id } = await params;
  const { body, error: bodyError } = await readJsonBody(req);
  if (bodyError) return bodyError;

  const parsed = addTastingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  const d = parsed.data;

  const { actor, error } = await resolveCellarActor(req);
  if (error) return error;

  const limited = cellarRateLimit(req, actor!.ownerId, "write", actor!.isProxy);
  if (limited) return limited;

  const tastingId = await addTasting(actor!.ownerId, id, {
    tastedAt: d.tastedAt ? new Date(d.tastedAt) : undefined,
    stage: d.stage ?? null,
    deltaVsPrev: d.deltaVsPrev ?? null,
    dims: d.dims ?? null,
    descriptors: d.descriptors ?? undefined,
    grams: d.grams ?? null,
    vessel: d.vessel ?? null,
    note: d.note ?? null,
    images: d.images ?? undefined,
    visibility: d.visibility ?? "private",
    elapsedSeconds: d.elapsedSeconds ?? null,
  });

  if (!tastingId) {
    return NextResponse.json({ error: "条目不存在" }, { status: 404 });
  }
  return NextResponse.json({ id: tastingId }, { status: 201 });
}

/**
 * GET /api/cellar/[id]/tastings —— 这条目的全部品鉴记录（时间轴）。
 *
 * 前端用它渲染「我的线」；条目页的「站长线对照」另走茶品页那条线。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!cellarEnabled()) return cellarDisabledResponse();

  const { id } = await params;
  const { actor, error } = await resolveCellarActor(req);
  if (error) return error;

  const limited = cellarRateLimit(req, actor!.ownerId, "read", actor!.isProxy);
  if (limited) return limited;

  const item = await getCellarItem(actor!.ownerId, id);
  if (!item) {
    return NextResponse.json({ error: "条目不存在" }, { status: 404 });
  }
  return NextResponse.json({ tastings: item.tastings });
}
