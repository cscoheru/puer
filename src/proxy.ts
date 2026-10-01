/**
 * Sets the `x-puer-locale` request header based on URL pathname.
 * Root layout reads it to emit `<html lang="zh-TW">` on /tw/... pages.
 * No redirects: avoids cloaking concerns (Googlebot and humans see the same URL).
 *
 * Next.js 16: the `middleware.ts` convention is deprecated and renamed to
 * `proxy.ts`. The default-exported function name is `proxy`.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isTw = pathname === "/tw" || pathname.startsWith("/tw/");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-puer-locale", isTw ? "zh-TW" : "zh-CN");
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: [
    // Skip Next internals, API routes, static assets, sitemap, robots, uploads.
    "/((?!_next/|api/|favicon.ico|icon.svg|robots\\.txt|sitemap.*|uploads/).*)",
  ],
};
