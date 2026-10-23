import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { clampListLimit, clampListPage, listTotalPages, paginationCapped, parseRequestedPage } from "@/lib/pagination-limits";
import { cellarRateLimit, readJsonBody, resolveCellarActor } from "@/lib/cellar-api";
import { createCellarItemSchema, zodMessage } from "@/lib/cellar-schemas";
import { createCellarItem, createTeaRequest, listCellarItems } from "@/lib/cellar-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/cellar —— 我的茶仓条目列表。
 *
 * 只认 session 里的操作者 —— **没有代录**（2026-10-23 站长拍板），
 * 条目只有一种归属：录入者自己。站内 `api/favorites` 的 GET 收 `?userId=`
 * 就能读别人收藏，那是反面教材。
 */
export async function GET(req: NextRequest) {

  const { searchParams } = new URL(req.url);

  const { actor, error } = await resolveCellarActor();
  if (error) return error;

  // requestedPage（请求页）与 page（夹取后的实际页）必须成对存在 ——
  // capped 靠它们的差值算。348b6f6 删掉过 requestedPage 的声明却留着用法，
  // 这个路由从此**每次**列表请求都 500。
  //
  // isAdmin 恒为 false：管理员在自己的茶仓上没有特权位了 —— 原来那个
  // 「后台一次拉全量别人茶仓」的视图就是代录，代录取消后没有了。
  const requestedPage = parseRequestedPage(searchParams.get("page"));
  const limit = clampListLimit(searchParams.get("limit"), { isAdmin: false });
  const page = clampListPage(requestedPage, { isAdmin: false });

  const limited = cellarRateLimit(req, actor!.ownerId, "read");
  if (limited) return limited;

  const { items, total } = await listCellarItems(actor!.ownerId, { page, limit });
  return NextResponse.json({
    items,
    total,
    page,
    limit,
    pages: listTotalPages(total, limit),
    capped: paginationCapped(requestedPage, page),
  });
}

/**
 * POST /api/cellar —— 添加一条茶。
 *
 * 两种来源：
 *  - `teaId`：茶品库里已有的茶；
 *  - `teaRequest`：自建茶品申请（同时进茶仓）。审核通过后由站长并入
 *    茶品库，条目会自动挂上那款茶。
 *
 * 归属只有一种：录入者自己。站长不代录（2026-10-23 站长拍板），
 * 所以这里没有 `targetUserId`，也没有「管理员写别人的条目」这条路。
 */
export async function POST(req: NextRequest) {
  // 第一道门是**可见性**：看不见茶仓的人回 404，不能让他拿到 400 的参数
  // 校验错误 —— 那等于告诉他「这个接口存在、还要这些字段」。
  const { actor, error } = await resolveCellarActor();
  if (error) return error;

  const { body, error: bodyError } = await readJsonBody(req);
  if (bodyError) return bodyError;

  const parsed = createCellarItemSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  const input = parsed.data;

  const limited = cellarRateLimit(req, actor!.ownerId, "write");
  if (limited) return limited;

  // 茶品必须存在且未进删除箱 —— 否则条目会挂在一款看不到的茶上。
  if (input.teaId) {
    const tea = await prisma.tea.findFirst({
      where: { id: input.teaId, deletedAt: null },
      select: { id: true },
    });
    if (!tea) {
      return NextResponse.json({ error: "茶品不存在" }, { status: 400 });
    }
  }

  // 自建茶品：先建申请，再把条目挂到申请上。
  let teaRequestId: string | null = null;
  if (input.teaRequest) {
    teaRequestId = await createTeaRequest(actor!.ownerId, {
      name: input.teaRequest.name,
      brand: input.teaRequest.brand ?? null,
      year: input.teaRequest.year ?? null,
      type: input.teaRequest.type ?? "raw",
      weightSpec: input.teaRequest.weightSpec ?? null,
      note: input.teaRequest.note ?? null,
    });
  }

  const id = await createCellarItem(actor!.ownerId, {
    teaId: input.teaId ?? null,
    teaRequestId,
    name: input.name ?? null,
    acquiredAt: input.acquiredAt ? new Date(input.acquiredAt) : null,
    qtyNote: input.qtyNote ?? null,
    remindEveryMonths: input.remindEveryMonths,
    // 评分来源恒为「自评」：茶仓里的每一条记录都由用户本人录入。
    storage: input.storage
      ? {
          storageScore: input.storage.storageScore ?? null,
          city: input.storage.city ?? null,
          container: input.storage.container ?? null,
        }
      : null,
  });

  return NextResponse.json({ id, teaRequestId }, { status: 201 });
}
