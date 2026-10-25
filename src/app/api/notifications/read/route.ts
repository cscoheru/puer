import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readJsonBody } from "@/lib/http-body";
import {
  checkRateLimit,
  getClientIP,
  rateLimitKey,
  LIMIT_API_GENERAL,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/notifications/read —— 把通知标记为已读。
 *
 * body: `{ ids: string[] }`（点开某一条）或 `{ all: true }`（面板上的「全部已读」）。
 *
 * ## 为什么要有这个接口
 *
 * 之前**全仓没有任何地方把 `read` 置为 true** —— 未读数只增不减，徽标永远是
 * 9+。F4 复饮提醒上线后，每天进来一条提醒会被埋在一堆「未读」里，用户根本
 * 看不见；而且 PRD §9 的核心指标「提醒点击到记录的转化率」要的正是**点击**
 * 这个信号。
 *
 * ## 防护
 *
 * - 只改**自己的**通知（where 里带 userId）—— 传别人的 id 不会命中。
 * - 请求体有 64KB 上限（`readJsonBody`）：`req.json()` 会把整个 body 读进内存
 *   才交给 zod，字段上限是解析**之后**才生效的。
 * - 限速（按 IP）：这是写接口，不限速就能被刷。
 * - 要求 `Content-Type: application/json`：带 `text/plain` 的跨站 fetch 属于
 *   「简单请求」，不触发预检 —— 不挡的话，第三方页面能让登录中的用户
 *   「全部已读」（影响很小，但白送一个 CSRF 原语）。
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return NextResponse.json(
      { error: "Content-Type 必须是 application/json" },
      { status: 415 },
    );
  }

  const ip = getClientIP(req);
  const { allowed } = checkRateLimit(
    rateLimitKey(ip, "notifications-read"),
    LIMIT_API_GENERAL,
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "操作过于频繁，请稍后再试" },
      { status: 429 },
    );
  }

  const { body, error: bodyError } = await readJsonBody(req);
  if (bodyError) return bodyError;

  const payload = (body ?? {}) as { ids?: unknown; all?: unknown };
  const ids: string[] = Array.isArray(payload.ids)
    ? payload.ids
        .filter((x: unknown): x is string => typeof x === "string")
        .slice(0, 100)
    : [];
  const all = payload.all === true;

  if (!all && ids.length === 0) {
    return NextResponse.json({ error: "请指定要标记的通知" }, { status: 400 });
  }

  const res = await prisma.notification.updateMany({
    where: {
      userId: session.user.id,
      read: false,
      ...(all ? {} : { id: { in: ids } }),
    },
    data: { read: true },
  });

  const unreadCount = await prisma.notification.count({
    where: { userId: session.user.id, read: false },
  });

  return NextResponse.json({ ok: true, marked: res.count, unreadCount });
}
