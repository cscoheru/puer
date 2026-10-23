import { NextRequest, NextResponse } from "next/server";
import {
  cellarDisabledResponse,
  cellarEnabled,
  cellarRateLimit,
  resolveCellarActor,
} from "@/lib/cellar-api";
import { searchCellarTeas } from "@/lib/cellar-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/cellar/teas?q=xxx —— 茶仓选茶用的搜索。
 *
 * ## 为什么不复用 `/api/teas`
 *
 * `/api/teas` 是全站共用的（发帖选茶、搜索页都在用），改它的排序与返回
 * 形状会波及那些地方。这里给茶仓单独一个：排序按**经典优先**，
 * 只返回选茶需要的几个字段。
 *
 * ## 为什么匹配 aliases
 *
 * `Tea.aliases` 一直只写不读。查过生产库：1686 款茶的 aliases 全是
 * **name 的副本**，所以今天匹配它跟匹配 name 等价。但它是唯一一处
 * 将来能放「班章」「老班章」这类俗称的地方 —— 现在接上，等站长补了
 * 真实别名就自动生效，不用改代码。
 */
export async function GET(req: NextRequest) {
  if (!cellarEnabled()) return cellarDisabledResponse();

  const { actor, error } = await resolveCellarActor(req);
  if (error) return error;

  const limited = cellarRateLimit(req, actor!.ownerId, "read", false);
  if (limited) return limited;

  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (!q) return NextResponse.json({ teas: [] });

  const teas = await searchCellarTeas(q);

  return NextResponse.json({ teas });
}
