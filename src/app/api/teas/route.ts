import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { clampListLimit, clampListPage, paginationCapped } from "@/lib/pagination-limits";
import { can } from "@/lib/permissions";
import { checkRateLimit, rateLimitKey, getClientIP, LIMIT_LIST_READ } from "@/lib/rate-limit";

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
  // P2-R6「发布新经典」：Lv.2+ 创建茶品时可同时入选经典普洱吧
  isClassic: z.boolean().optional(),
});

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const brand = searchParams.get("brand");
  const year = searchParams.get("year");
  const type = searchParams.get("type");
  const search = searchParams.get("q");
  const requestedPage = parseInt(searchParams.get("page") || "1", 10);
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

  const where: Record<string, unknown> = {};
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
  if (!session?.user || session.user.level < 2) {
    return NextResponse.json({ error: "需要Lv.2茶人及以上才能创建茶品百科" }, { status: 403 });
  }

  const body = await req.json();
  const data = teaSchema.parse(body);

  const tea = await prisma.tea.create({
    data: {
      ...data,
      createdBy: session.user.id,
    },
  });

  return NextResponse.json(tea, { status: 201 });
}
