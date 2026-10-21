/**
 * Proxy (Next.js 16；`middleware.ts` 约定已废弃并改名为 `proxy.ts`)。
 *
 * 两件事：
 *
 * 1. **语言标识**：按 URL pathname 设置 `x-puer-locale` 请求头，根布局据此
 *    输出 `<html lang="zh-TW">`。不做重定向 —— 避免 cloaking 顾虑
 *    （Googlebot 与真人看到同一个 URL）。
 *    与客户端 provider（src/i18n/context.tsx）共用 `isTwPath`，保证服务端
 *    的 `<html lang>` 与客户端的强制语言永远不会不一致。
 *
 * 2. **反滥用限速**（PRD v0.3 §8）：API 读请求的 IP 级限速与批量遍历检测。
 *    详见下方 `rateLimitResponse` / `bannedResponse` 注释。
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isTwPath } from "@/i18n/translations";
import { isFeatureEnabled } from "@/lib/feature-flags";

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── API 路径：走反滥用限速，不做 locale 处理 ────────────────────
  if (pathname.startsWith("/api/")) {
    return handleApiRequest(request, pathname);
  }

  const isTw = isTwPath(pathname);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-puer-locale", isTw ? "zh-TW" : "zh-CN");
  return NextResponse.next({ request: { headers: requestHeaders } });
}

// ══════════════════════════════════════════════════════════════════════
// 反滥用：IP 级限速 + 批量遍历检测
// PRD v0.3 §8「抓取：按 IP 与账号限速；列表翻页深度设上限；检测批量遍历
// 行为并临时封禁；不提供公开的批量接口；记录并告警」
// ══════════════════════════════════════════════════════════════════════

/**
 * 为什么放在 proxy 层而不是逐个路由加：
 * 逐个加会漏 —— 每加一个新接口就多一个可被批量遍历的缺口。proxy 在所有
 * 路由之前执行，一处覆盖全部 API 读请求。
 *
 * 为什么不复用 `src/lib/rate-limit.ts`：那份限速器带 setInterval 定时清扫
 * 与跨路由共享语义，而 Next 官方文档提醒 proxy 不应依赖共享模块与全局
 * 状态（为 CDN 部署场景考虑）。这里刻意自包含：一份内存表 + 惰性清扫，
 * 不 import 任何带副作用的模块（feature-flags 是纯函数，无副作用）。
 *
 * 账号维度的限速在路由层做 —— 那里已经加载了会话，不用再解一次 cookie。
 */

/** 统计窗口。 */
const WINDOW_MS = 60_000;
/** 窗口内允许的读请求数。 */
const MAX_REQUESTS = 120;
/** 连续超限多少次后临时封禁。 */
const BAN_THRESHOLD = 3;
/** 封禁时长。 */
const BAN_MS = 30 * 60_000;
/** 每处理多少个请求扫一次过期项（惰性清扫，避免 setInterval 常驻）。 */
const SWEEP_EVERY = 200;

interface Bucket {
  /** 窗口内的请求时间戳。 */
  hits: number[];
  /** 连续超限次数。 */
  strikes: number;
  /** 封禁到期时间戳；0 = 未封禁。 */
  bannedUntil: number;
}

const buckets = new Map<string, Bucket>();
let requestCount = 0;

/** 惰性清扫：把过期的桶从表里摘掉。 */
function sweep(now: number): void {
  for (const [key, b] of buckets) {
    if (b.bannedUntil > 0) {
      if (b.bannedUntil <= now) {
        // 封禁到期：清零重开
        b.bannedUntil = 0;
        b.strikes = 0;
        b.hits = [];
      }
      continue;
    }
    const idle = b.hits.length === 0 || now - b.hits[b.hits.length - 1] > WINDOW_MS;
    if (idle) buckets.delete(key);
  }
}

/**
 * 取客户端 IP。nginx 配了完整的 Cloudflare `set_real_ip_from` +
 * `real_ip_header X-Forwarded-For`，且应用端口只绑 127.0.0.1（外部只能经
 * nginx 进来），所以 X-Forwarded-For 的第一个值是真客户端 IP，不可伪造。
 */
function clientIP(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return (
    req.headers.get("x-real-ip") || req.headers.get("cf-connecting-ip") || "unknown"
  );
}

/**
 * 哪些路径不参与限速：
 *  - /api/admin/*：管理接口由 requireAdmin 把关；后台页面并发请求多
 *  - /api/auth/*：登录注册有专门的限速（限错了会误伤正常登录）
 *  - /api/upload：文件上传，本就不是读接口
 */
function isExemptPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/admin") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/upload")
  );
}

function handleApiRequest(request: NextRequest, pathname: string): NextResponse {
  // feature flag 关闭 → 完全不介入（PRD §0 的开关位）。
  if (!isFeatureEnabled("antiAbuseRateLimit")) {
    return NextResponse.next();
  }
  // 只限读。写操作由路由层按账号限（见 src/lib/rate-limit.ts 的既有配置）。
  if (request.method !== "GET" && request.method !== "HEAD") {
    return NextResponse.next();
  }
  if (isExemptPath(pathname)) {
    return NextResponse.next();
  }

  const now = Date.now();
  const ip = clientIP(request);

  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = { hits: [], strikes: 0, bannedUntil: 0 };
    buckets.set(ip, bucket);
  }

  // 封禁期内 → 直接拒绝，不再计数（否则持续请求会无限延长封禁）。
  if (bucket.bannedUntil > now) {
    return bannedResponse(Math.ceil((bucket.bannedUntil - now) / 1000));
  }
  if (bucket.bannedUntil > 0) {
    // 封禁刚到期
    bucket.bannedUntil = 0;
    bucket.strikes = 0;
    bucket.hits = [];
  }

  // 滑动窗口：丢掉窗口外的记录
  const cutoff = now - WINDOW_MS;
  while (bucket.hits.length > 0 && bucket.hits[0] <= cutoff) bucket.hits.shift();
  bucket.hits.push(now);

  if (bucket.hits.length > MAX_REQUESTS) {
    bucket.strikes += 1;
    if (bucket.strikes >= BAN_THRESHOLD) {
      bucket.bannedUntil = now + BAN_MS;
      bucket.hits = [];
      console.warn(
        `[anti-abuse] 临时封禁 IP=${ip} 连续 ${bucket.strikes} 次超出 ` +
          `${MAX_REQUESTS} 次/分钟，封禁 ${BAN_MS / 60000} 分钟（路径 ${pathname}）`,
      );
      return bannedResponse(Math.ceil(BAN_MS / 1000));
    }
    const retryAfter = Math.max(1, Math.ceil((bucket.hits[0] + WINDOW_MS - now) / 1000));
    console.warn(
      `[anti-abuse] 限速 IP=${ip} 超出 ${MAX_REQUESTS} 次/分钟（路径 ${pathname}），` +
        `第 ${bucket.strikes}/${BAN_THRESHOLD} 次`,
    );
    return rateLimitedResponse(retryAfter);
  }

  // 惰性清扫
  if (++requestCount % SWEEP_EVERY === 0) sweep(now);

  return NextResponse.next();
}

function rateLimitedResponse(retryAfter: number): NextResponse {
  return NextResponse.json(
    { error: "请求过于频繁，请稍后再试", retryAfter },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit": String(MAX_REQUESTS),
        "X-RateLimit-Remaining": "0",
        // 告警钩子：监控可按这个头抓被限速的客户端
        "X-AntiAbuse": "rate-limited",
      },
    },
  );
}

function bannedResponse(retryAfter: number): NextResponse {
  return NextResponse.json(
    { error: "检测到批量抓取行为，已临时限制访问", retryAfter },
    {
      status: 403,
      headers: {
        "Retry-After": String(retryAfter),
        "X-AntiAbuse": "temporarily-banned",
      },
    },
  );
}

export const config = {
  matcher: [
    // 页面：设置 locale 头。跳过 Next 内部路由、静态资源、robots、uploads。
    "/((?!_next/|api/|favicon.ico|icon.svg|robots\\.txt|sitemap.*|uploads/).*)",
    // API：走反滥用限速。
    "/api/:path*",
  ],
};
