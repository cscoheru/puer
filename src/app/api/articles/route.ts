import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { checkUserCanPost } from "@/lib/check-mute";
import { prisma } from "@/lib/prisma";
import { grantExp } from "@/lib/exp";
import { pingSearchEngines } from "@/lib/sitemap-ping";
import { z } from "zod";
import { checkRateLimit, rateLimitKey, getClientIP, LIMIT_POST } from "@/lib/rate-limit";
import { screenContent } from "@/lib/moderation";
import { visibleArticleWhere } from "@/lib/article-visibility";

const articleSchema = z.object({
  type: z.enum(["article", "tasting", "discussion"]),
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  summary: z.string().max(500).optional(),
  teaId: z.string().optional(),
  tastingScores: z.record(z.string(), z.number()).optional(),
  brewMethod: z.string().optional(),
  waterTemp: z.number().optional(),
  teaWeight: z.string().optional(),
  steepCount: z.number().optional(),
  tags: z.array(z.string()).default([]),
  visibility: z.enum(["public", "private"]).default("public"),
});

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type");
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "20");

  const session = await auth();
  const where: Record<string, unknown> = { ...visibleArticleWhere(session?.user?.id) };
  if (type) where.type = type;

  const [articles, total] = await Promise.all([
    prisma.article.findMany({
      where,
      select: {
        id: true,
        type: true,
        title: true,
        summary: true,
        createdAt: true,
        replyCount: true,
        upvotes: true,
        downvotes: true,
        viewCount: true,
        isPinned: true,
        lastRepliedAt: true,
        author: { select: { id: true, username: true, avatar: true, level: true } },
        tea: { select: { id: true, name: true, brand: true, year: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.article.count({ where }),
  ]);

  return NextResponse.json({ articles, total, page, limit });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { canPost, reason } = await checkUserCanPost(session.user.id);
  if (!canPost) {
    return NextResponse.json({ error: reason }, { status: 403 });
  }

  // Rate limit: 10 posts per hour per IP
  const ip = getClientIP(req);
  const { allowed } = checkRateLimit(rateLimitKey(ip, `post:${session.user.id}`), LIMIT_POST);
  if (!allowed) {
    return NextResponse.json({ error: "发帖过于频繁，请稍后再试" }, { status: 429 });
  }

  const body = await req.json();
  const data = articleSchema.parse(body);

  // 内容审核:敏感词命中→拒绝;AI 放行→发布;可疑/故障→送审
  const mod = await screenContent(`${data.title} ${data.content}`);
  if (mod.decision === "reject") {
    return NextResponse.json({ error: "内容含违规信息,无法发布" }, { status: 400 });
  }
  const isPublish = mod.decision === "publish";

  const article = await prisma.article.create({
    data: {
      ...data,
      authorId: session.user.id,
      status: isPublish ? "published" : "pending_review",
      // 内联字面量:满足 Prisma Json 字段的索引签名要求
      moderation: isPublish
        ? undefined
        : { decision: mod.decision, categories: mod.categories, confidence: mod.confidence, reason: mod.reason, source: mod.source },
    },
  });

  // 待审帖不立即计经验/推搜索引擎;通过后由审核队列补发
  if (isPublish) {
    const expType = data.type === "tasting" ? "post_tasting" : "post_article";
    await grantExp(session.user.id, expType, article.id);
    pingSearchEngines();
  }

  return NextResponse.json({ ...article, pendingReview: !isPublish }, { status: 201 });
}
