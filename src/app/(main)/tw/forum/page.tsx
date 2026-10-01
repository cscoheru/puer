/**
 * /tw/forum — Traditional Chinese mirror of /forum.
 *
 * Same query params, same data, same child components as the simplified page.
 * The locale reaches those components two ways:
 *   - server components (ForumSidebar / LatestPosts) take an explicit `locale`
 *     prop, because they render their DB-sourced strings through s2tw;
 *   - the client component (ForumFeed) reads I18nProvider, which derives
 *     zh-TW from the pathname and ignores the cookie on /tw/... routes.
 *
 * The two mechanisms are NOT interchangeable, which is the trap on this route:
 * `_()` from the zhCNtoTW map crosses the client boundary, `convertText` does
 * not (it is server-only). ForumFeed is a client component rendering DB text,
 * so anything handed to it must already be converted *here* — see
 * `toTraditionalFeed` / `toTraditionalBoards`. Passing the raw query result
 * through compiles fine and renders a simplified feed inside traditional
 * chrome, which is what this page originally did.
 *
 * canonical stays on /forum (the DB-authoritative copy). JSON-LD is limited to
 * BreadcrumbList; CollectionPage/Article live on the SC page only, since Google
 * wants structured data on the canonical rather than on language alternates.
 */
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { safeJsonLdStringify } from "@/lib/json-ld";
import { convertText } from "@/lib/s2t";
import { fetchForumFeed, toTraditionalFeed, toTraditionalBoards } from "@/lib/forum-feed-server";
import ForumFeed from "@/components/forum-feed";
import ForumSidebar from "@/components/forum-sidebar";
import LatestPosts from "@/components/latest-posts";
import type { Metadata } from "next";

const SC_TITLE = "普洱茶论坛_普洱茶交流社区_生普熟普品鉴 - PuerHub";
const SC_DESCRIPTION =
  "PuerHub 普洱茶论坛：生普/熟普品鉴交流、大益等经典中老期茶档案、仓储行情讨论与茶友问答。普洱茶爱好者聚集地，以茶会友。";
const SC_INTRO = "生普/熟普品鉴交流、大益等经典中老期茶档案、仓储行情讨论与茶友问答。";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  // The TW title/description are derived from the SC literals so the two can
  // never describe the page differently — only the glyphs and vocabulary
  // change (品鉴 → 品鑑, 档案 → 檔案).
  const title = convertText(SC_TITLE);
  const description = convertText(SC_DESCRIPTION);
  return {
    title: { absolute: title },
    description,
    alternates: {
      canonical: "/forum",
      languages: {
        "zh-Hans-CN": "/forum",
        "zh-Hant-TW": "/tw/forum",
        "x-default": "/forum",
      },
    },
    openGraph: {
      title: convertText("普洱茶论坛 - 生普熟普品鉴 | PuerHub 普洱茶社区"),
      description: convertText("生普/熟普品鉴交流、大益等经典中老期茶档案、仓储行情讨论与茶友问答。"),
      // Without this the TW document inherits Next's `zh_CN` default and tells
      // crawlers the opposite of what the hreflang cluster says.
      locale: "zh_TW",
    },
  };
}

export default async function TwForumPage(props: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const searchParams = await props.searchParams;
  // Mirrors the simplified page's tab vocabulary exactly — `?tab=` is part of
  // the URL contract shared by both trees, so it must not be translated.
  const VALID_TABS = ["day", "week", "month", "latest", "essence"] as const;
  let tab = searchParams.tab || "week";
  if (tab === "hot") tab = "week";
  if (!(VALID_TABS as readonly string[]).includes(tab)) tab = "week";
  const session = await auth();

  const boards = await prisma.board.findMany({
    orderBy: { sortOrder: "asc" },
  });

  // Both of these feed ForumFeed, a client component — convert before the
  // boundary, not after (see the file header).
  const { articles } = await fetchForumFeed({
    tab,
    userId: session?.user?.id,
    limit: 24,
  });
  const feedArticles = toTraditionalFeed(articles);
  const traditionalBoards = toTraditionalBoards(boards);

  return (
    <div className="max-w-screen-2xl mx-auto px-2 md:px-4">
      {/* BreadcrumbList JSON-LD — the only structured data on /tw/ pages. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLdStringify({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            inLanguage: "zh-TW",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: convertText("首頁"), item: "https://puer.im" },
              { "@type": "ListItem", position: 2, name: convertText("論壇"), item: "https://puer.im/forum" },
            ],
          }),
        }}
      />
      <div className="pt-4 pb-1">
        <h1 className="text-lg md:text-xl font-serif font-bold text-stone-800">{convertText("普洱茶论坛")}</h1>
        <p className="text-xs md:text-sm text-stone-500 mt-1">{convertText(SC_INTRO)}</p>
      </div>
      <div className="flex gap-4 md:gap-6 pt-2">
        <ForumSidebar locale="zh-TW" />
        <div className="flex-1 min-w-0">
          <ForumFeed
            articles={feedArticles}
            boards={traditionalBoards.map((b) => ({ id: b.id, name: b.name, slug: b.slug, icon: b.icon }))}
            currentUserId={session?.user?.id}
            tab={tab}
          />
        </div>
        <LatestPosts locale="zh-TW" />
      </div>
    </div>
  );
}
