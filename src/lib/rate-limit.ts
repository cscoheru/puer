/**
 * Simple in-memory rate limiter for API routes and auth.
 * Resets on server restart (acceptable for this scale).
 */

interface RateEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateEntry>();

// Periodic cleanup every 5 minutes
if (typeof setInterval !== "undefined") {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  }, 300_000);
  // 别让这个定时器**吊住进程**：Node 里 unref 之后它不再阻止事件循环退出
  // （否则任何 import 了这个模块的脚本跑完都退不出去 —— 单测就是被它挂住的）。
  if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
}

export interface RateLimitConfig {
  /** Max requests allowed within the window */
  max: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

export function checkRateLimit(
  key: string,
  config: RateLimitConfig
): { allowed: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + config.windowMs });
    return { allowed: true, remaining: config.max - 1, resetIn: config.windowMs };
  }

  if (entry.count >= config.max) {
    return { allowed: false, remaining: 0, resetIn: entry.resetAt - now };
  }

  entry.count++;
  return { allowed: true, remaining: config.max - entry.count, resetIn: entry.resetAt - now };
}

/** Build a rate limit key from IP + identifier */
export function rateLimitKey(ip: string, identifier?: string): string {
  return identifier ? `${ip}:${identifier}` : ip;
}

/**
 * 取访客的真实 IP。
 *
 * ## 为什么不能取 X-Forwarded-For 的**第一段**
 *
 * 站点在 Cloudflare 后面，前面还有一层 nginx。nginx 转发给应用时写的是
 * `X-Forwarded-For: $proxy_add_x_forwarded_for` —— 也就是
 * 「**客户端自己发来的那段** + 真实来源」。**第一段是客户端可以随便写的**：
 *
 * ```
 * curl -H 'X-Forwarded-For: 8.8.8.8' https://puer.im/...
 * ```
 *
 * 实测（2026-10-24）：这条伪造的 IP 被原样写进了 `users.registrationIp`
 * 和 `password_reset_requests.requestIp` —— 后台看到的「申请 IP」是假的，
 * 而所有按 IP 的限速（登录、注册、忘记密码…）都能被绕开。
 *
 * ## 现在怎么取
 *
 * 1. **优先 `X-Real-IP`** —— nginx 用 `proxy_set_header X-Real-IP $remote_addr`
 *    **覆盖**掉客户端送来的值，而 `$remote_addr` 已经过 realip 模块按
 *    Cloudflare 的可信 IP 段校正过，就是访客的真实 IP。
 *    （应用容器只监听 127.0.0.1:3002，流量必经 nginx，所以这个头可信。）
 * 2. 没有 X-Real-IP 时，取 X-Forwarded-For 的**最后一段** —— nginx 追加的
 *    真实来源就在末尾。
 */
export function getClientIP(req: Request): string {
  const headers = (req as unknown as { headers: Headers }).headers;
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = headers.get("x-forwarded-for");
  const last = xff
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  return last || "unknown";
}

// ── Preset configs ───────────────────────────────────────────────────

export const LIMIT_LOGIN = { max: 5, windowMs: 15 * 60 * 1000 };      // 5 attempts per 15 min
export const LIMIT_REGISTER = { max: 3, windowMs: 60 * 60 * 1000 };   // 3 per hour
export const LIMIT_API_GENERAL = { max: 60, windowMs: 60 * 1000 };     // 60 per minute
export const LIMIT_POST = { max: 10, windowMs: 60 * 60 * 1000 };       // 10 posts per hour
export const LIMIT_QA = { max: 6, windowMs: 60 * 1000 };               // 6 Q&A per minute (LLM cost)
export const LIMIT_REVIEW = { max: 3, windowMs: 60 * 60 * 1000 };       // 3 manual review requests per hour
export const LIMIT_FORGOT_PASSWORD = { max: 3, windowMs: 60 * 60 * 1000 }; // 3 password-reset requests per hour
export const LIMIT_RESET_STATUS = { max: 10, windowMs: 60 * 60 * 1000 };  // 10 reset-status lookups per hour

/**
 * 列表接口的账号级限速（PRD v0.3 §8「按 IP 与账号限速」）。
 *
 * proxy 层做的是 IP 级（覆盖匿名爬虫，见 src/proxy.ts）；这里是账号级 ——
 * 同一个账号换 IP 也逃不掉。阈值比 IP 级宽松：登录用户往往在同一个出口
 * IP 下（办公室/家里），IP 级对共享出口下的所有人一起计数，账号级才是
 * 真正区分「一个人」的口径。
 *
 * 60 次/分钟：真人翻页与筛选的量级；爬虫脚本通常远高于此。
 */
export const LIMIT_LIST_READ = { max: 60, windowMs: 60 * 1000 };
