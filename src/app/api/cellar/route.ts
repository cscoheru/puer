import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { clampListLimit, clampListPage, paginationCapped } from "@/lib/pagination-limits";
import { cellarRateLimit, logCellarProxy, readJsonBody, resolveCellarActor } from "@/lib/cellar-api";
import { createCellarItemSchema, zodMessage } from "@/lib/cellar-schemas";
import { createCellarItem, createTeaRequest, listCellarItems } from "@/lib/cellar-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/cellar —— 我的茶仓条目列表。
 *
 * 读接口**只认 session 里的操作者**。管理员可以传 `?targetUserId=`
 * 看别人的（代录时要用），但那需要 `cellar:manage` 权限 ——
 * 站内 `api/favorites` 的 GET 收 `?userId=` 就能读别人收藏，那是反面教材。
 */
export async function GET(req: NextRequest) {

  const { searchParams } = new URL(req.url);
  const targetUserId = searchParams.get("targetUserId");

  const { actor, error } = await resolveCellarActor(req, targetUserId);
  if (error) return error;

  // 代录视角（管理员看别人的）不受翻页上限约束；普通用户按站内约定收敛。
  const isAdmin = actor!.isProxy;
  // 默认页大小只保留在 pagination-limits.ts 一处 —— 这里再写一遍 "20"，
  // 将来改默认时这个路由会静默不跟着变。
  //
  // requestedPage 是**用户请求的原始页码**，page 是夹取后的实际页码；
  // 两者分开才知道有没有被收敛（capped）。它们必须都存在 ——
  // 少了 requestedPage，paginationCapped 拿不到参数，
  // 这个路由会在**每次**列表请求时抛 ReferenceError（整个 500）。
  const requestedPage = parseInt(searchParams.get("page") || "1", 10);
  const limit = clampListLimit(searchParams.get("limit"), { isAdmin });
  const page = clampListPage(requestedPage, { isAdmin });

  const limited = cellarRateLimit(req, actor!.ownerId, "read", isAdmin);
  if (limited) return limited;

  // 代录读别人私有数据 —— 留痕。
  if (actor!.isProxy) {
    logCellarProxy("read", actor!.actorId, actor!.ownerId, "list");
  }

  const { items, total } = await listCellarItems(actor!.ownerId, { page, limit });
  return NextResponse.json({
    items,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
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
 * 管理员可传 `targetUserId` 代录 —— 仓储评分的来源会标成「站长评」。
 *
 * 代录有两个前提：`cellar:manage` 权限，**以及操作者自己看得见茶仓**
 * （FEATURE_CELLAR=1，或 uid ∈ EDITOR_AUTHOR_UIDS ∪ CELLAR_UIDS）——
 * 可见性门在权限门之前，规则见 src/lib/cellar-guard.ts。白名单外的管理员
 * 拿到的也是 404（而不是 403），跟看不见这个功能的普通用户一样。
 */
export async function POST(req: NextRequest) {
  // 第一道门是**可见性**：看不见茶仓的人回 404，不能让他拿到 400 的参数
  // 校验错误 —— 那等于告诉他「这个接口存在、还要这些字段」。
  // targetUserId 藏在 body 里，归属判定得等 body 解析完，所以先过一遍
  // 不带 targetUserId 的守卫（可见性 + 登录态 + 合成账号），
  // 解析完再为代录路径补一次归属判定。
  const gate = await resolveCellarActor(req);
  if (gate.error) return gate.error;

  const { body, error: bodyError } = await readJsonBody(req);
  if (bodyError) return bodyError;

  const parsed = createCellarItemSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  const input = parsed.data;

  // 代录（targetUserId 在 body 里）再过一次归属判定。
  const { actor, error } = input.targetUserId
    ? await resolveCellarActor(req, input.targetUserId)
    : gate;
  if (error) return error;

  const limited = cellarRateLimit(req, actor!.ownerId, "write", actor!.isProxy);
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

  if (actor!.isProxy) {
    logCellarProxy("write", actor!.actorId, actor!.ownerId, "create-item");
  }

  const id = await createCellarItem(actor!.ownerId, {
    teaId: input.teaId ?? null,
    teaRequestId,
    name: input.name ?? null,
    acquiredAt: input.acquiredAt ? new Date(input.acquiredAt) : null,
    qtyNote: input.qtyNote ?? null,
    remindEveryMonths: input.remindEveryMonths,
    // 代录的评分来源是「站长评」，本人录的是「自评」。
    storage: input.storage
      ? {
          storageScore: input.storage.storageScore ?? null,
          assessedBy: actor!.isProxy ? "editor" : "self",
          city: input.storage.city ?? null,
          container: input.storage.container ?? null,
        }
      : null,
  });

  return NextResponse.json({ id, teaRequestId }, { status: 201 });
}
