import { NextRequest, NextResponse } from "next/server";
import { cellarDisabledResponse, cellarEnabled, cellarRateLimit, resolveCellarActor } from "@/lib/cellar-api";
import { listVocab } from "@/lib/cellar-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/cellar/vocab —— 描述词库（快速品鉴的「点选描述词」用）。
 *
 * 词表是**社区共有**的（站长笔记里统计出来的），所以登录用户都能读；
 * 但要登录才能用 —— 未登录的人没有茶仓，也没有点选的场景。
 */
export async function GET(req: NextRequest) {
  if (!cellarEnabled()) return cellarDisabledResponse();

  const { actor, error } = await resolveCellarActor(req);
  if (error) return error;

  const limited = cellarRateLimit(req, actor!.ownerId, "read", false);
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const category = searchParams.get("category");
  const ageBracket = searchParams.get("ageBracket");
  const dim = searchParams.get("dim");

  const entries = await listVocab({
    ...(category === "raw" || category === "ripe" || category === "any"
      ? { category }
      : {}),
    ...(ageBracket ? { ageBracket } : {}),
    ...(dim ? { dim } : {}),
  });

  return NextResponse.json({ entries });
}
