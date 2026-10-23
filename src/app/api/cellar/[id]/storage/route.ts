import { NextRequest, NextResponse } from "next/server";
import {
  cellarDisabledResponse,
  cellarEnabled,
  cellarRateLimit,
  readJsonBody,
  resolveCellarActor,
} from "@/lib/cellar-api";
import { addStorageEpochSchema, zodMessage } from "@/lib/cellar-schemas";
import { addStorageEpoch } from "@/lib/cellar-data";

export const dynamic = "force-dynamic";

/**
 * POST /api/cellar/[id]/storage —— 换仓。
 *
 * 换仓 = **新增一条仓储期**，旧的保留 —— 历史要能还原（「这饼茶去年在
 * 哪、什么仓」是这条线的价值所在）。所以不是改字段，是加一条记录。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!cellarEnabled()) return cellarDisabledResponse();

  const { id } = await params;
  const { body, error: bodyError } = await readJsonBody(req);
  if (bodyError) return bodyError;

  const parsed = addStorageEpochSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  const d = parsed.data;

  const { actor, error } = await resolveCellarActor(req);
  if (error) return error;

  const limited = cellarRateLimit(req, actor!.ownerId, "write", actor!.isProxy);
  if (limited) return limited;

  const epochId = await addStorageEpoch(actor!.ownerId, id, {
    startsAt: d.startsAt ? new Date(d.startsAt) : undefined,
    storageScore: d.storageScore ?? null,
    // 代录的评分来源是「站长评」，本人录的是「自评」。
    assessedBy: actor!.isProxy ? "editor" : "self",
    city: d.city ?? null,
    container: d.container ?? null,
  });

  if (!epochId) {
    return NextResponse.json({ error: "条目不存在" }, { status: 404 });
  }
  return NextResponse.json({ id: epochId }, { status: 201 });
}
