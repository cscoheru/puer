/**
 * 茶仓接口的共同守卫（PRD v0.3 §5 Phase 2）。
 *
 * ## 为什么单独抽一个文件
 *
 * 7 个茶仓接口都要判同一串东西：登录了吗？是合成账号吗？限速了吗？
 * 代录的话对方有 `cellar:manage` 吗？散着写 7 遍，早晚有一遍漏判 ——
 * 漏判的那遍就是越权。
 *
 * ## 三条语义要分清
 *
 *  - **401**：没登录。前台接口用这个（`requireAdmin` 那种 403 是后台语义）。
 *  - **403**：登录了但没这个权限（代录别人、合成账号）。
 *  - **404**：功能没开（feature flag 关闭）。不返回 403 是因为
 *    「功能不存在」不该让爬虫知道有个待上线的功能。
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { isFeatureEnabled } from "@/lib/feature-flags";
import {
  checkRateLimit,
  getClientIP,
  rateLimitKey,
  LIMIT_API_GENERAL,
  LIMIT_LIST_READ,
} from "@/lib/rate-limit";

/** 功能开关。关闭时所有茶仓接口都当「不存在」。 */
export function cellarEnabled(): boolean {
  return isFeatureEnabled("cellar");
}

/** 功能未开启时的响应。 */
export function cellarDisabledResponse(): NextResponse {
  return NextResponse.json({ error: "功能尚未开启" }, { status: 404 });
}

export interface CellarActor {
  /** 条目的所有者 id（代录时是目标用户的 id）。 */
  ownerId: string;
  /** 操作者自己的 id。 */
  actorId: string;
  /** 是不是管理员代录。 */
  isProxy: boolean;
}

/**
 * 解析操作者与条目归属。
 *
 * @param targetUserId 目标用户 id（只有代录时传）。传了就必须是本人，
 *                     否则要求 `cellar:manage` 权限。
 */
export async function resolveCellarActor(
  req: NextRequest,
  targetUserId?: string | null,
): Promise<{ actor: CellarActor | null; error: NextResponse | null }> {
  const session = await auth();
  if (!session?.user) {
    return {
      actor: null,
      error: NextResponse.json({ error: "请先登录" }, { status: 401 }),
    };
  }

  // 合成账号不是人 —— 它们不该产生「用户的一手记录」（PRD §4 原则 5）。
  if (session.user.isSynthetic) {
    return {
      actor: null,
      error: NextResponse.json(
        { error: "合成账号不能使用茶仓功能" },
        { status: 403 },
      ),
    };
  }

  let ownerId = session.user.id;
  let isProxy = false;
  if (targetUserId && targetUserId !== session.user.id) {
    if (!can(session.user, "cellar:manage")) {
      return {
        actor: null,
        error: NextResponse.json({ error: "无权访问他人的茶仓" }, { status: 403 }),
      };
    }
    ownerId = targetUserId;
    isProxy = true;
  }

  return {
    actor: { ownerId, actorId: session.user.id, isProxy },
    error: null,
  };
}

/**
 * 账号级限速。
 *
 * 读与写用不同阈值：读是翻页（频繁但无害），写是记品鉴（一天几次）。
 * 管理员豁免 —— 后台要一次拉全量。
 */
export function cellarRateLimit(
  req: NextRequest,
  userId: string,
  kind: "read" | "write",
  isAdmin: boolean,
): NextResponse | null {
  if (isAdmin) return null;
  const ip = getClientIP(req);
  const { allowed, resetIn } = checkRateLimit(
    rateLimitKey(ip, `cellar:${kind}:${userId}`),
    kind === "read" ? LIMIT_LIST_READ : LIMIT_API_GENERAL,
  );
  if (allowed) return null;
  return NextResponse.json(
    { error: "请求过于频繁，请稍后再试" },
    { status: 429, headers: { "Retry-After": String(Math.ceil(resetIn / 1000)) } },
  );
}

/** 读 JSON 体；不是合法 JSON 返回 400 而不是让异常冒成 500。 */
export async function readJsonBody(req: NextRequest): Promise<
  { body: unknown; error: NextResponse | null }
> {
  try {
    return { body: await req.json(), error: null };
  } catch {
    return {
      body: null,
      error: NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 }),
    };
  }
}
