/**
 * 茶仓接口的共同守卫（PRD v0.3 §5 Phase 2）。
 *
 * ## CSRF：靠的是 cookie 的 SameSite，不是显式校验
 *
 * 这七个写接口只用 session cookie 认证，没有 CSRF token、也没有
 * Origin 校验 —— 与站内其它接口一致。抗 CSRF 靠的是 Auth.js 默认的
 * `SameSite=Lax` 会话 cookie：跨站的 POST/PATCH/DELETE **不带** cookie。
 *
 * ⚠️ 这条不变量没有被任何断言钉住。将来若为了跨站嵌入把 cookie 改成
 * `SameSite=None`，这七个写接口会同时变成 CSRF 目标。改 cookie 配置时
 * 必须回来这里补 Origin 校验。
 *
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
 *  - **404**：**这个账号看不见茶仓**（全局 flag 关着，且 uid 不在白名单里）。
 *    不返回 401/403 是因为「功能不存在」不该让爬虫知道有个待上线的功能。
 *
 * ## 可见性在这里收口
 *
 * 判定（FEATURE_CELLAR 全局开关 / uid 白名单）在 `cellarVisibleTo`
 * （src/lib/cellar-guard.ts，纯函数可单测），**每个茶仓接口的第一道门都是
 * `resolveCellarActor`**。路由里不要再各写一遍 feature flag 判断 ——
 * 那是以前 14 处重复判定的来源，漏一处就是没门禁的接口。
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { cellarVisibleTo, decideCellarAccess } from "@/lib/cellar-guard";
import { prisma } from "@/lib/prisma";
import {
  checkRateLimit,
  getClientIP,
  rateLimitKey,
  LIMIT_API_GENERAL,
  LIMIT_LIST_READ,
} from "@/lib/rate-limit";

/**
 * 功能未开启时的响应。
 *
 * **可见性判定统一在这里收口**：所有茶仓接口都先过 `resolveCellarActor`，
 * 由它判断「这个人能不能看见茶仓」。所以路由里**不需要**再各判一次
 * feature flag —— 以前每条路由都写一遍 `if (!cellarEnabled())`，漏一处
 * 就是个没门禁的接口。
 *
 * 模块私有：路由一律走 `resolveCellarActor`，不要再单独 import 它 ——
 * 单独判一次就等于把可见性判定又分叉出去。
 */
function cellarDisabledResponse(): NextResponse {
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
 * 判定本身在 `src/lib/cellar-guard.ts`（纯函数，可单测）；这里只负责
 * 取 session、问权限、把结果翻译成 HTTP 响应。
 *
 * @param targetUserId 目标用户 id（只有代录时传）。传了就必须是本人，
 *                     否则要求 `cellar:manage` 权限。
 */
export async function resolveCellarActor(
  req: NextRequest,
  targetUserId?: string | null,
): Promise<{ actor: CellarActor | null; error: NextResponse | null }> {
  const session = await auth();

  // ── 可见性先判 ──────────────────────────────────────────────────────
  // 顺序很重要：不可见的人回 **404**（功能不存在），不是 401/403。
  // 回 401 等于告诉爬虫「这里有个接口，只是要登录」—— 一个还没上线
  // 的功能不该被知道存在。
  //
  // 判定规则（FEATURE_CELLAR 全局开关 / uid 白名单）见 src/lib/cellar-guard.ts。
  if (!cellarVisibleTo(session?.user)) {
    return { actor: null, error: cellarDisabledResponse() };
  }

  const decision = decideCellarAccess(
    session?.user
      ? {
          id: session.user.id,
          isSynthetic: session.user.isSynthetic,
        }
      : null,
    targetUserId ?? null,
    can(session?.user, "cellar:manage"),
  );

  if (!decision.ok) {
    return {
      actor: null,
      error: NextResponse.json({ error: decision.error }, { status: decision.status }),
    };
  }

  // 代录的目标必须是**真实的真人账号**。合成账号不是人，不该有一手记录；
  // 写错 id 更糟 —— 会在一个不存在的所有者名下建出数据（外键会拒，
  // 但那时是一个 500，而不是一句人话）。
  if (decision.access.isProxy) {
    const target = await prisma.user.findFirst({
      where: { id: decision.access.ownerId },
      select: { id: true, isSynthetic: true },
    });
    if (!target) {
      return {
        actor: null,
        error: NextResponse.json({ error: "目标用户不存在" }, { status: 400 }),
      };
    }
    if (target.isSynthetic) {
      return {
        actor: null,
        error: NextResponse.json(
          { error: "不能给合成账号代录茶仓" },
          { status: 400 },
        ),
      };
    }
  }

  return { actor: decision.access, error: null };
}

/**
 * 代录的**审计日志**。
 *
 * 管理员能读别人的私有茶仓条目 —— 这件事不留痕就等于没有约束：
 * 出了事没法查是谁看的。所以每次代录读/写都记一行。
 *
 * 走应用日志（stdout → docker logs），不新建表 —— F2 阶段够用，
 * 真要做成产品化的审计台账再说。
 *
 * **记的是「代录尝试」，不是「代录已完成」**：这一行写在真正的读写**之前**，
 * 所以写库失败时它同样在。失败的代录恰恰是最该被查到的那种 —— 只记成功
 * 的话，出事那次反而没记录。查日志的人别把 action=write 读成「写入已成功」。
 */
export function logCellarProxy(
  action: "read" | "write",
  actorId: string,
  targetUserId: string,
  detail?: string,
): void {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event: "cellar.proxy",
      action,
      actorId,
      targetUserId,
      detail: detail ?? null,
    }),
  );
}

/**
 * 限速。
 *
 * **两个桶**：
 *   - IP 桶（`ip:cellar:kind:userId`）：挡住同一出口 IP 下的滥用；
 *   - **账号桶**（`acct:cellar:kind:userId`）：与 IP 无关。
 *
 * 只用共享的 `rateLimitKey(ip, id)` 是不够的 —— 它的 key 以 IP 为主，
 * 换个出口 IP 就是新桶，「同一个账号换 IP 也逃不掉」这句话就不成立。
 * 所以这里额外加一个只按账号计的桶，两者取更严的那个。
 *
 * 读与写用不同阈值：读是翻页（频繁但无害），写是记品鉴。
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
  const limit = kind === "read" ? LIMIT_LIST_READ : LIMIT_API_GENERAL;

  const ipBucket = checkRateLimit(
    rateLimitKey(ip, `cellar:${kind}:${userId}`),
    limit,
  );
  const acctBucket = checkRateLimit(`acct:cellar:${kind}:${userId}`, limit);

  if (ipBucket.allowed && acctBucket.allowed) return null;
  const resetIn = Math.max(ipBucket.resetIn, acctBucket.resetIn);
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
