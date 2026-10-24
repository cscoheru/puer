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
 * 9 个茶仓接口都要判同一串东西：登录了吗？是合成账号吗？限速了吗？
 * 散着写 9 遍，早晚有一遍漏判 —— 漏判的那遍就是越权。
 *
 * ## 三条语义要分清
 *
 *  - **401**：没登录。前台接口用这个（`requireAdmin` 那种 403 是后台语义）。
 *  - **403**：登录了但没这个权限（合成账号）。
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
import { cellarVisibleTo, decideCellarAccess } from "@/lib/cellar-guard";
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
  /** 条目的所有者 id —— 就是登录的人自己。 */
  ownerId: string;
}

/**
 * 解析操作者与条目归属。
 *
 * 判定本身在 `src/lib/cellar-guard.ts`（纯函数，可单测）；这里只负责
 * 取 session、把结果翻译成 HTTP 响应。
 *
 * **没有代录**（2026-10-23 站长拍板）：茶仓里的每一条记录都由用户本人录入，
 * 所以归属只有一种 —— 登录的人自己。这个函数因此不再接受目标用户 id，
 * 也不再问 `cellar:manage`（那项权限现在只管茶品库与自建茶品审核）。
 *
 * 不收 `req`：判定只需要 session（可见性靠 session 里的 uid 白名单），
 * 请求本身在这条路径上没有任何用途 —— 收下不用只会让人以为它参与了判定。
 */
export async function resolveCellarActor(): Promise<{
  actor: CellarActor | null;
  error: NextResponse | null;
}> {
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
  );

  if (!decision.ok) {
    return {
      actor: null,
      error: NextResponse.json({ error: decision.error }, { status: decision.status }),
    };
  }

  return { actor: decision.access, error: null };
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
 *
 * **没有管理员豁免**（2026-10-23）：豁免原本是为「后台一次拉全量**别人**的
 * 茶仓」开的，代录取消后没有这个视图了 —— 管理员在自己的茶仓上和普通用户
 * 一样，不该有一条后门。
 */
export function cellarRateLimit(
  req: NextRequest,
  userId: string,
  kind: "read" | "write",
): NextResponse | null {
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

/**
 * 请求体大小上限。
 *
 * 合法载荷最大约 25KB（备注 5000 字 + 描述词 + 9 张图 + 3 段视频的 URL），
 * 64KB 留足了余量。
 *
 * 为什么要卡：`req.json()` 会把**整个请求体**读进内存才交给 zod，
 * 而 zod 的字段上限是在解析**之后**才生效的 —— 一个几百 MB 的 body
 * 会先被完整缓冲下来，再被拒绝。认证过的账号一分钟能打 60 次，
 * 每次都占一大块内存。
 */
const MAX_BODY_BYTES = 64 * 1024;

/** 读 JSON 体；不是合法 JSON 返回 400 而不是让异常冒成 500。 */
export async function readJsonBody(req: NextRequest): Promise<
  { body: unknown; error: NextResponse | null }
> {
  // 有 Content-Length 就能在读之前判断。没有的话（分块传输）拦不住 ——
  // 那要改成流式计数，见上面的说明。
  const len = req.headers.get("content-length");
  if (len && Number(len) > MAX_BODY_BYTES) {
    return {
      body: null,
      error: NextResponse.json(
        { error: "请求体太大" },
        { status: 413 },
      ),
    };
  }
  try {
    return { body: await req.json(), error: null };
  } catch {
    return {
      body: null,
      error: NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 }),
    };
  }
}
