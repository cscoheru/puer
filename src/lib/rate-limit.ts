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
