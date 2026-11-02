import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { clampListLimit, clampListPage, paginationCapped, parseRequestedPage } from "@/lib/pagination-limits";
import { can } from "@/lib/permissions";
import { checkRateLimit, rateLimitKey, getClientIP, LIMIT_LIST_READ } from "@/lib/rate-limit";
import { visibleTeaWhere } from "@/lib/tea-tier";
import { canManageTeas, canPromoteToClassic } from "@/lib/tea-permissions";

const teaSchema = z.object({
  name: z.string().min(1).max(200),
  brand: z.string().min(1).max(100),
  year: z.number().int().min(1900).max(2100),
  batch: z.string().max(50).optional(),
  type: z.enum(["raw", "ripe"]),
  originRegion: z.string().max(100).optional(),
  weightSpec: z.string().max(50).optional(),
  storageCondition: z.string().max(100).optional(),
  coverImage: z.string().optional(),
  gallery: z.array(z.string()).optional(),
  description: z.string().optional(),
  // ⚠️ 这里**故意没有** isClassic：2026-11-02 起「经典」不再是用户能自称的
  // 选项 —— zod 会把请求里的 isClassic **strip 掉**，创建逻辑改读原始 body，
  // 再按权限（canPromoteToClassic）重新判定。留着这个字段的后果是：
  // 谁都能把自建的茶直接塞进公开的经典普洱区。
});

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const brand = searchParams.get("brand");
  const year = searchParams.get("year");
  const type = searchParams.get("type");
  const search = searchParams.get("q");
  const requestedPage = parseRequestedPage(searchParams.get("page"));
  const limit = parseInt(searchParams.get("limit") || "20", 10);

  // 茶品库 = 全集：列表对登录用户返回全部茶品；**未登录者只返回经典子集**
  // （与 /tea/[id] 的「非经典详情需登录」闸门一致，避免匿名枚举在建档）。
  // 带关键词的搜索（发帖/发品鉴时选茶）本来就要登录才能用，不受影响。
  const session = await auth();
  // 「管理员」在列表接口里的特殊待遇（限速豁免、翻页不设上限）走权限层，
  // 而不是直接比对角色字符串 —— 将来加 editor/moderator 时改矩阵即可。
  const isAdmin = can(session?.user, "admin:access");

  // F0 反滥用：账号级限速（IP 级在 proxy 层，见 src/proxy.ts）。管理员不受限。
  if (!isAdmin && session?.user?.id) {
    const ip = getClientIP(req);
    const { allowed, resetIn } = checkRateLimit(
      rateLimitKey(ip, `list:teas:${session.user.id}`),
      LIMIT_LIST_READ,
    );
    if (!allowed) {
      return NextResponse.json(
        { error: "请求过于频繁，请稍后再试" },
        { status: 429, headers: { "Retry-After": String(Math.ceil(resetIn / 1000)) } },
      );
    }
  }

  // F0 反滥用：单页条数与翻页深度封顶，管理员不受限（后台要 limit=9999
  // 一次拉全量茶品）。越界是「收敛」不是报错。
  const safeLimit = clampListLimit(limit, { isAdmin });
  const page = clampListPage(requestedPage, { isAdmin });

  // 公开目录的可见性口径只有一份（src/lib/tea-tier.ts）：「待整理」对
  // 所有人隐藏（含管理员）—— 站长自己搜到的结果也不能有重复。
  //
  // 后台的整理队列要看到全部，用 ?includePending=1（仅管理员可用）。
  const includePending =
    searchParams.get("includePending") === "1" && isAdmin;
  const where: Record<string, unknown> = includePending
    ? {}
    : visibleTeaWhere();
  if (!session?.user) where.isClassic = true;
  if (brand) where.brand = brand;
  if (year) where.year = parseInt(year);
  if (type) where.type = type;
  if (search) where.name = { contains: search, mode: "insensitive" };

  const [teas, total] = await Promise.all([
    prisma.tea.findMany({
      where: { ...where, deletedAt: null },
      include: {
        _count: { select: { articles: true, tastingNotes: true } },
        user: { select: { username: true } },
      },
      orderBy: [{ tastingNoteCount: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * safeLimit,
      take: safeLimit,
    }),
    prisma.tea.count({ where: { ...where, deletedAt: null } }),
  ]);

  return NextResponse.json({
    teas,
    total,
    page,
    limit: safeLimit,
    capped: paginationCapped(requestedPage, page),
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  // 2026-11-02：闸门从「等级 >= 2」换成**权限**。
  //
  // 等级闸门的意思是「任何 Lv.2 爱茶人都能建茶品、还能把自己建的茶直接
  // 设成经典」—— 而经典区的读点此前又不按 needsReview 过滤，于是用户自建的
  // 茶会**直接公开出现在经典普洱区**（列表公开、点进去 404）。
  // 站长的口径：只有管理员与站长能建经典/编辑茶品；普通用户唯一的参与
  // 方式是发跟进帖。
  if (!canManageTeas(session?.user)) {
    return NextResponse.json({ error: "只有管理员与站长可以创建茶品" }, { status: 403 });
  }

  const body = await req.json();
  const data = teaSchema.parse(body);

  // 「是否经典」**由服务端按权限判定** —— 前端勾了不算数。
  //
  // zod schema 里没有 isClassic（它会被 strip 掉），所以这里直接读原始 body：
  // 想发布为经典，必须**同时**满足「请求里勾了」与「这个人有权策展」。
  const publishAsClassic =
    body?.isClassic === true && canPromoteToClassic(session?.user);

  const tea = await prisma.tea.create({
    data: {
      ...data,
      isClassic: publishAsClassic,
      // 站长/管理员自己策展的经典茶视为「已整理」（needsReview=false），
      // 直接出现在经典普洱区；其余一律进「待整理」层 —— 只有创建者与站长看得见，
      // 由站长在后台整理（改名/合并/提升为经典）后才进公开层。
      needsReview: !publishAsClassic,
      createdBy: session!.user.id,
    },
  });

  // 明确告诉创建者：这条现在**只有站长看得见**，公开目录里搜不到。
  return NextResponse.json(
    { ...tea, pending: true },
    { status: 201 },
  );
}
