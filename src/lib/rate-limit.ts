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
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  }, 300_000);
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

/** Extract client IP from request headers */
export function getClientIP(req: Request): string {
  return (
    (req as unknown as { headers: Headers }).headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    (req as unknown as { headers: Headers }).headers.get("x-real-ip") ||
    "unknown"
  );
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
