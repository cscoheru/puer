import { NextRequest, NextResponse } from "next/server";
import {
  cellarDisabledResponse,
  cellarEnabled,
  cellarRateLimit,
  readJsonBody,
  resolveCellarActor,
} from "@/lib/cellar-api";
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
  if (!cellarEnabled()) return cellarDisabledResponse();

  const { body, error: bodyError } = await readJsonBody(req);
  if (bodyError) return bodyError;

  const { actor, error } = await resolveCellarActor(req);
  if (error) return error;

  const confirm = (body as { confirm?: unknown } | null)?.confirm;
  if (confirm !== "DELETE") {
    return NextResponse.json(
      { error: "请确认删除：请求体需带 confirm: \"DELETE\"" },
      { status: 400 },
    );
  }

  const limited = cellarRateLimit(req, actor!.ownerId, "write", actor!.isProxy);
  if (limited) return limited;

  const result = await purgeCellarData(actor!.ownerId);
  return NextResponse.json({ ok: true, ...result });
}
