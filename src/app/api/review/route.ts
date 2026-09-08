import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { checkRateLimit, rateLimitKey, getClientIP, LIMIT_REVIEW } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// same-site upload paths only (mirrors /api/qa)
const IMG_RE = /^\/uploads\/forum\/[A-Za-z0-9._-]+\.(jpe?g|png|gif|webp)$/;

const createSchema = z.object({
  question: z.string().trim().min(1).max(500),
  image_urls: z.array(z.string().max(200)).min(1).max(3),
  ai_answer: z.string().max(8000).optional(),
  ai_verdict: z.string().max(40).optional(),
  ai_confidence: z.number().min(0).max(1).optional(),
  ai_sku_name: z.string().max(200).optional(),
});

// 手动提交人工鉴定(登录必需 — 匿名游客只能看 AI 回答)
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录后可提交人工鉴定" }, { status: 401 });
  }
  const { allowed } = checkRateLimit(
    rateLimitKey(getClientIP(req), `review:${session.user.id}`),
    LIMIT_REVIEW
  );
  if (!allowed) {
    return NextResponse.json({ error: "提交过于频繁，请稍后再试" }, { status: 429 });
  }

  let body: z.infer<typeof createSchema>;
  try {
    body = createSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "参数不完整" }, { status: 400 });
  }
  if (body.image_urls.some((u) => !IMG_RE.test(u))) {
    return NextResponse.json({ error: "无效的图片地址" }, { status: 400 });
  }

  const review = await prisma.teaReview.create({
    data: {
      userId: session.user.id,
      question: body.question,
      imageUrls: body.image_urls,
      source: "manual",
      aiAnswer: body.ai_answer,
      aiVerdict: body.ai_verdict,
      aiConfidence: body.ai_confidence,
      aiSkuName: body.ai_sku_name,
    },
    select: { id: true, status: true, createdAt: true },
  });
  return NextResponse.json({ review }, { status: 201 });
}

// 我的鉴定单列表(最近 50 条)
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }
  const reviews = await prisma.teaReview.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      question: true,
      imageUrls: true,
      source: true,
      aiVerdict: true,
      aiConfidence: true,
      aiSkuName: true,
      status: true,
      reviewNote: true,
      createdAt: true,
      reviewedAt: true,
    },
  });
  return NextResponse.json({ reviews });
}
