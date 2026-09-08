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

// Records a deduplicated "real visitor" view. Fire-and-forget from the client
// beacon: must never throw to the client (would trigger retries and inflate
// counts), so all errors are swallowed and answered 200.
export async function POST(req: NextRequest) {
  try {
    const ua = req.headers.get("user-agent") || "";
    if (BOT_RE.test(ua)) return NextResponse.json({ ok: true, bot: true });

    const { articleId } = await req.json();
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
    const visitorKey =
      userId ??
      createHash("sha256")
        .update(`${getClientIP(req)}|${ua}`)
        .digest("hex")
        .slice(0, 16);

    await prisma.$executeRaw`
      INSERT INTO article_views ("articleId", "visitorKey", day, "createdAt")
      VALUES (${articleId}, ${visitorKey}, CURRENT_DATE, NOW())
      ON CONFLICT ("articleId", "visitorKey", day) DO NOTHING
    `;

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[views] error", err);
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
