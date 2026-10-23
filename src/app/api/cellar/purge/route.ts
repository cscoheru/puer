import { NextRequest, NextResponse } from "next/server";
import { cellarRateLimit, readJsonBody, resolveCellarActor } from "@/lib/cellar-api";
import { purgeCellarData } from "@/lib/cellar-data";

export const dynamic = "force-dynamic";

/**
 * POST /api/cellar/purge —— 一键删除我的全部茶仓数据。
 *
 * PRD §4：用户数据可随时删除。删的是**茶仓**（条目 + 品鉴 + 仓储期），
 * 不删账号、不删发帖 —— 「删除我的全部数据」指的是茶仓这条线的数据。
 *
 * 需要 body 里带 `confirm: "DELETE"`：这是不可撤销的操作，
 * 双击/误触不该删掉一个人几个月的记录。前端还要再弹一次确认框。
 */
export async function POST(req: NextRequest) {
  // 第一道门是**可见性**：看不见茶仓的人回 404，不能让他拿到 400 的
  // 「请确认删除」—— 那等于告诉他「这个接口存在、而且是个删数据的口子」。
  const { actor, error } = await resolveCellarActor();
  if (error) return error;

  const { body, error: bodyError } = await readJsonBody(req);
  if (bodyError) return bodyError;

  const confirm = (body as { confirm?: unknown } | null)?.confirm;
  if (confirm !== "DELETE") {
    return NextResponse.json(
      { error: "请确认删除：请求体需带 confirm: \"DELETE\"" },
      { status: 400 },
    );
  }

  const limited = cellarRateLimit(req, actor!.ownerId, "write");
  if (limited) return limited;

  const result = await purgeCellarData(actor!.ownerId);
  return NextResponse.json({ ok: true, ...result });
}
