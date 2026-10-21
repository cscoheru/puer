import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getClientIP } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Declared crawlers — defense in depth. The primary bot filter is that the
// client beacon never fires under JS-less crawlers. NOTE: deliberately does
// NOT match "MicroMessenger" (WeChat in-app browser is a real human).
const BOT_RE =
  /bot|spider|crawl|archiver|googlebot|baidu|bingbot|slurp|duckduckbot|yandexbot|semrush|ahrefsbot|facebookexternalhit|twitterbot|linkedinbot|python-requests|curl|wget|headless|lighthouse|siteaudit|dataforseo/i;

/** 取 Referer 的 host 并规范化（去 www、去端口）。空串 = 无 Referer。 */
function refererHost(raw: string | null): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.toLowerCase().replace(/^www\./, "").slice(0, 120);
  } catch {
    return "";
  }
}

/**
 * Records a deduplicated "real visitor" view.
 *
 * This is the second track of the view-count pair (see the ArticleView model
 * comment): `Article.viewCount` is incremented by the SSR page on every render
 * (crawlers, refreshes and the site owner's own views included) and serves
 * relative heat ranking. This table is the one that answers "how many real
 * people actually read", with a source channel attached.
 *
 * Failure behaviour: the client beacon must never throw at the client (it
 * would trigger retries and inflate counts), so errors are swallowed in the
 * response — but they are **logged**, loudly. The previous version swallowed
 * them silently against a table that did not exist, so the feature never
 * worked and nobody noticed for months. A swallowed error that leaves no
 * trace is a delayed explosion (AGENTS.md).
 */
export async function POST(req: NextRequest) {
  try {
    const ua = req.headers.get("user-agent") || "";
    if (BOT_RE.test(ua)) return NextResponse.json({ ok: true, bot: true });

    const { articleId, landingPath } = await req.json();
    if (typeof articleId !== "string" || articleId.length < 10 || articleId.length > 60) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }

    const session = await auth();
    const userId = session?.user?.id;
    const role = session?.user?.role;

    // Exclude the site owner/admin from real-visitor stats.
    if (role === "admin") return NextResponse.json({ ok: true, admin: true });

    // Resolve the article to check authorship (also confirms it exists).
    const article = await prisma.article.findUnique({
      where: { id: articleId },
      select: { authorId: true },
    });
    if (!article) return NextResponse.json({ ok: false }, { status: 404 });

    // Exclude the author viewing their own post.
    if (userId && userId === article.authorId) {
      return NextResponse.json({ ok: true, author: true });
    }

    // Visitor key: stable userId for logged-in users, anonymous hash otherwise.
    const ip = getClientIP(req);
    const visitorKey =
      userId ??
      createHash("sha256")
        .update(`${ip}|${ua}`)
        .digest("hex")
        .slice(0, 16);

    // Source channel. The Referer tells us where the reader came from
    // (search / social / another site / a direct visit). Never store a raw IP —
    // the baseline report only needs "how many different people", not who.
    const rawReferer = req.headers.get("referer") || "";
    const refHost = refererHost(rawReferer);
    // 落地路径由页面上的 beacon 传当前 URL（这个接口自身的 pathname 没用）。
    const landing =
      typeof landingPath === "string" && landingPath.startsWith("/")
        ? landingPath.slice(0, 300)
        : null;

    await prisma.articleView.upsert({
      where: {
        articleId_visitorKey_day: {
          articleId,
          visitorKey,
          day: new Date(new Date().toISOString().slice(0, 10)),
        },
      },
      create: {
        articleId,
        visitorKey,
        day: new Date(new Date().toISOString().slice(0, 10)),
        refererHost: refHost || null,
        referer: rawReferer ? rawReferer.slice(0, 500) : null,
        landingPath: landing,
        userAgent: ua.slice(0, 300),
        isLoggedIn: !!userId,
      },
      update: {},
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    // 静默降级 = 延迟爆炸：这个接口失败时客户端拿到的仍是 200，但必须留下
    // 痕迹。曾经的教训 —— 这里的 INSERT 指向一张从未创建的表，异常被吞掉且
    // 没有任何日志，功能失效了好几个月都没人发现。
    console.error("[views] 记录真实读者视图失败", err);
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
