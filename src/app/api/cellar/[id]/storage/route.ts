import { NextRequest, NextResponse } from "next/server";
import { cellarRateLimit, readJsonBody, resolveCellarActor } from "@/lib/cellar-api";
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

  const { id } = await params;

  // 第一道门是**可见性**：看不见茶仓的人回 404，不能让他拿到 400 的参数
  // 校验错误 —— 那等于告诉他「这个接口存在、还要这些字段」。
  const { actor, error } = await resolveCellarActor();
  if (error) return error;

  const { body, error: bodyError } = await readJsonBody(req);
  if (bodyError) return bodyError;

  const parsed = addStorageEpochSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  const d = parsed.data;

  const limited = cellarRateLimit(req, actor!.ownerId, "write");
  if (limited) return limited;

  const epochId = await addStorageEpoch(actor!.ownerId, id, {
    startsAt: d.startsAt ? new Date(d.startsAt) : undefined,
    storageScore: d.storageScore ?? null,
    city: d.city ?? null,
    container: d.container ?? null,
  });

  if (!epochId) {
    return NextResponse.json({ error: "条目不存在" }, { status: 404 });
  }
  return NextResponse.json({ id: epochId }, { status: 201 });
}
