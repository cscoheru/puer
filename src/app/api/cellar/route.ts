import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { clampListLimit, clampListPage, paginationCapped } from "@/lib/pagination-limits";
import {
  cellarDisabledResponse,
  cellarEnabled,
  cellarRateLimit,
  readJsonBody,
  resolveCellarActor,
} from "@/lib/cellar-api";
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
  if (!cellarEnabled()) return cellarDisabledResponse();

  const { searchParams } = new URL(req.url);
  const targetUserId = searchParams.get("targetUserId");

  const { actor, error } = await resolveCellarActor(req, targetUserId);
  if (error) return error;

  // 代录视角（管理员看别人的）不受翻页上限约束；普通用户按站内约定收敛。
  const isAdmin = actor!.isProxy;
  const requestedPage = Number(searchParams.get("page") || "1");
  const requestedLimit = Number(searchParams.get("limit") || "20");
  const limit = clampListLimit(requestedLimit, { isAdmin, fallback: 20 });
  const page = clampListPage(requestedPage, { isAdmin });

  const limited = cellarRateLimit(req, actor!.ownerId, "read", isAdmin);
  if (limited) return limited;

  const { items, total } = await listCellarItems(actor!.ownerId, { page, limit });
  return NextResponse.json({
    items,
    total,
    page,
    limit,
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
 */
export async function POST(req: NextRequest) {
  if (!cellarEnabled()) return cellarDisabledResponse();

  const { body, error: bodyError } = await readJsonBody(req);
  if (bodyError) return bodyError;

  const parsed = createCellarItemSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  const input = parsed.data;

  const { actor, error } = await resolveCellarActor(req, input.targetUserId);
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
