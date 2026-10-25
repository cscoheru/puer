import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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
 * 只改**自己的**通知（where 里带 userId）—— 传别人的 id 不会命中。
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body?.ids)
    ? body.ids.filter((x: unknown): x is string => typeof x === "string").slice(0, 100)
    : [];
  const all = body?.all === true;

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
