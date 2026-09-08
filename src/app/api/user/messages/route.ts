import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { filterMessage, sanitizeContent } from "@/lib/message-filter";
import { checkRateLimit, rateLimitKey, getClientIP, LIMIT_POST } from "@/lib/rate-limit";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") || "received"; // received | sent
  const page = parseInt(searchParams.get("page") || "1");
  const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);

  const where = type === "sent"
    ? { senderId: session.user.id }
    : { receiverId: session.user.id };

  const [messages, total] = await Promise.all([
    prisma.userMessage.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        sender: { select: { id: true, username: true, nickname: true, avatar: true } },
        receiver: { select: { id: true, username: true, nickname: true, avatar: true } },
      },
    }),
    prisma.userMessage.count({ where }),
  ]);

  return NextResponse.json({ data: messages, total, page, limit });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  // Rate limit: 10 messages per hour
  const ip = getClientIP(req);
  const { allowed } = checkRateLimit(rateLimitKey(ip, `msg:${session.user.id}`), LIMIT_POST);
  if (!allowed) {
    return NextResponse.json({ error: "留言过于频繁，请稍后再试" }, { status: 429 });
  }

  const body = await req.json();
  const { receiverId, content } = body;

  if (!receiverId || !content) {
    return NextResponse.json({ error: "参数不完整" }, { status: 400 });
  }

  // Cannot message yourself
  if (receiverId === session.user.id) {
    return NextResponse.json({ error: "不能给自己留言" }, { status: 400 });
  }

  // Check receiver exists
  const receiver = await prisma.user.findUnique({ where: { id: receiverId } });
  if (!receiver) {
    return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  }

  // Content filter
  const filtered = filterMessage(content);
  if (!filtered.valid) {
    return NextResponse.json({ error: filtered.reason }, { status: 400 });
  }

  const message = await prisma.userMessage.create({
    data: {
      senderId: session.user.id,
      receiverId,
      content: sanitizeContent(content),
    },
    include: {
      sender: { select: { id: true, username: true, nickname: true, avatar: true } },
    },
  });

  return NextResponse.json(message, { status: 201 });
}
