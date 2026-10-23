import { NextRequest, NextResponse } from "next/server";
import {
  cellarDisabledResponse,
  cellarEnabled,
  cellarRateLimit,
  readJsonBody,
  resolveCellarActor,
} from "@/lib/cellar-api";
import { createTeaRequestSchema, zodMessage } from "@/lib/cellar-schemas";
import { createTeaRequest } from "@/lib/cellar-data";

export const dynamic = "force-dynamic";

/**
 * POST /api/cellar/tea-requests —— 只提交自建茶品申请，不进茶仓。
 *
 * 用户可能只是想让社区收录这款茶，跟自己的茶仓无关。
 * 想「申请 + 同时进茶仓」用 `POST /api/cellar` 传 `teaRequest`。
 */
export async function POST(req: NextRequest) {
  if (!cellarEnabled()) return cellarDisabledResponse();

  const { body, error: bodyError } = await readJsonBody(req);
  if (bodyError) return bodyError;

  const parsed = createTeaRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }

  const { actor, error } = await resolveCellarActor(req);
  if (error) return error;

  const limited = cellarRateLimit(req, actor!.ownerId, "write", false);
  if (limited) return limited;

  const id = await createTeaRequest(actor!.ownerId, {
    name: parsed.data.name,
    brand: parsed.data.brand ?? null,
    year: parsed.data.year ?? null,
    type: parsed.data.type ?? "raw",
    weightSpec: parsed.data.weightSpec ?? null,
    note: parsed.data.note ?? null,
  });

  return NextResponse.json({ id }, { status: 201 });
}
