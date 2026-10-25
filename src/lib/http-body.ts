/**
 * 读 JSON 请求体的公共实现（带体积上限）。
 *
 * 原本放在 `src/lib/cellar-api.ts`，但它与「茶仓」无关 —— 任何写接口都该
 * 用它（`req.json()` 会把**整个请求体**读进内存才交给 zod，而 zod 的字段
 * 上限是在解析**之后**才生效的：几百 MB 的 body 会先被完整缓冲下来，
 * 再被拒绝）。所以抽到这里，茶仓那边保留 re-export（已有调用点不用改）。
 */
import { NextRequest, NextResponse } from "next/server";

/**
 * 请求体大小上限。
 *
 * 合法载荷最大约 25KB（备注 5000 字 + 描述词 + 9 张图 + 3 段视频的 URL），
 * 64KB 留足了余量。
 */
export const MAX_BODY_BYTES = 64 * 1024;

/** 读 JSON 体；不是合法 JSON 返回 400 而不是让异常冒成 500。 */
export async function readJsonBody(req: NextRequest): Promise<
  { body: unknown; error: NextResponse | null }
> {
  // 有 Content-Length 就能在读之前判断。没有的话（分块传输）拦不住 ——
  // 那要改成流式计数，见上面的说明。
  const len = req.headers.get("content-length");
  if (len && Number(len) > MAX_BODY_BYTES) {
    return {
      body: null,
      error: NextResponse.json(
        { error: "请求体太大" },
        { status: 413 },
      ),
    };
  }
  try {
    return { body: await req.json(), error: null };
  } catch {
    return {
      body: null,
      error: NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 }),
    };
  }
}
