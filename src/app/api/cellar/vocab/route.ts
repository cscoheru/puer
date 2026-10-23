import { NextRequest, NextResponse } from "next/server";
import { cellarDisabledResponse, cellarEnabled, cellarRateLimit, resolveCellarActor } from "@/lib/cellar-api";
import { filterVocab } from "@/lib/cellar";
import { listVocab } from "@/lib/cellar-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/cellar/vocab —— 描述词库（快速品鉴的「点选描述词」用）。
 *
 * 词表是**社区共有**的（站长笔记里统计出来的），所以登录用户都能读；
 * 但要登录才能用 —— 未登录的人没有茶仓，也没有点选的场景。
 *
 * ## 为什么用 filterVocab 而不是直接查库
 *
 * 库里 `category` 有三种值：raw / ripe / **any**。any 的意思是「生熟都
 * 适用」。如果直接用 Prisma 的 `category: "raw"` 过滤，**any 的词一个都
 * 不会出现** —— 而「烟香」这类词恰恰是生熟都有的常用词。
 *
 * 所以这里取回全部条目，再用 `filterVocab` 做筛选（精确匹配优先于 any）。
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

  const all = await listVocab();
  const entries = filterVocab(
    all.map((e) => ({
      tag: e.tag,
      category: e.category === "raw" || e.category === "ripe" ? e.category : "any",
      ageBracket: e.ageBracket,
      dim: e.dim,
    })),
    {
      ...(category === "raw" || category === "ripe" ? { category } : {}),
      ...(ageBracket ? { ageBracket } : {}),
      ...(dim ? { dim } : {}),
    },
  );

  return NextResponse.json({ entries });
}
