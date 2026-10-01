import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { safeJsonLdStringify } from "@/lib/json-ld";
import { pickDocumentLocale } from "@/i18n/translations";
import type { Locale } from "@/i18n/translations";
import { convertText } from "@/lib/s2t";

// What language the *document* is. Not the reader's language — see
// `pickDocumentLocale` for why the cookie must stay out of this. Both
// `generateMetadata` and the component below need the same verdict, so the
// read lives here once rather than being re-derived in two places.
async function documentLang(): Promise<Locale> {
  return pickDocumentLocale((await headers()).get("x-puer-locale"));
}

const SITE_KEYWORDS = [
  "普洱茶",
  "普洱论坛",
  "品茶",
  "茶友社区",
  "茶叶评测",
  "普洱茶交流",
  "puer tea",
  "品茶论坛",
  "茶文化",
];

const SITE_TITLE = "Puêr 普洱茶论坛 — 以茶会友，品鉴生普熟普经典普洱";
const SITE_DESCRIPTION =
  "Puêr（puer.im）普洱茶爱好者社区论坛：生普/熟普品鉴交流、大益等经典中老期普洱茶档案与行情讨论、仓储知识与茶友问答。以茶会友，品鉴真味。";
const OG_TITLE = "Puêr — 以茶会友，品鉴真味";
const OG_DESCRIPTION = "中老期普洱茶爱好者社区，品鉴笔记、茶品百科、茶友交流";
const TWITTER_DESCRIPTION = "中老期普洱茶爱好者社区";
const JSONLD_DESCRIPTION = "中老期普洱茶爱好者社区 — 品鉴笔记、茶品百科、茶友交流";

/**
 * Site-wide metadata, converted when the document is the `/tw/` one.
 *
 * This is a function rather than a static `metadata` object for one reason: on a
 * traditional page every text field below has to ship converted. Next merges a
 * route's `generateMetadata` over this one field-by-field, so any field a route
 * leaves unset **falls back to these strings**. When this was a static
 * simplified object, `/tw/forum` set `title`, `description` and `openGraph` but
 * not `keywords` or `twitter` — and those two silently inherited the simplified
 * text, putting 普洱论坛 / 茶叶评测 / 爱好者社区 into a `zh-TW` document. The
 * same had already happened to the thread page and been fixed there only, which
 * is why the fix belongs here: converting the source means no future `/tw/`
 * route can re-leak it by forgetting a field.
 *
 * Note the vocabulary is converted, not localized: `convertText` is opencc
 * s2tw (glyph-level, Taiwan standard), so 普洱论坛 → 普洱論壇. Rewording for
 * how a Taiwanese reader would actually phrase it is a separate, editorial job.
 */
export async function generateMetadata(): Promise<Metadata> {
  const lang = await documentLang();
  // Gated rather than unconditional: the zh-CN branch must stay byte-identical
  // to what the site has always shipped. Applying convertText to simplified
  // input is a no-op in practice, but leaving it unapplied keeps the SC path
  // independent of opencc entirely.
  const ctw = (s: string) => (lang === "zh-TW" ? convertText(s) : s);

  return {
    metadataBase: new URL("https://puer.im"),
    title: {
      default: ctw(SITE_TITLE),
      template: "%s | Puêr",
    },
    description: ctw(SITE_DESCRIPTION),
    keywords: SITE_KEYWORDS.map(ctw),
    alternates: { canonical: "/" },
    openGraph: {
      title: ctw(OG_TITLE),
      description: ctw(OG_DESCRIPTION),
      type: "website",
      // A locale code, not a glyph conversion — s2tw would leave "zh_CN" alone
      // and the TW document would keep claiming zh_CN to every crawler.
      locale: lang === "zh-TW" ? "zh_TW" : "zh_CN",
      siteName: "Puêr",
      url: "https://puer.im",
    },
    twitter: {
      card: "summary_large_image",
      title: "Puêr",
      description: ctw(TWITTER_DESCRIPTION),
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
      },
    },
    verification: {
      google: process.env.NEXT_PUBLIC_GOOGLE_VERIFICATION || "",
    },
    icons: {
      icon: [
        { url: "/favicon.ico", type: "image/x-icon" },
        { url: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      ],
      shortcut: "/favicon.ico",
    },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // P1-tw: proxy.ts (formerly middleware.ts in Next ≤15) sets `x-puer-locale`
  // so this layout can emit `<html lang="zh-TW">` on /tw/... pages without a
  // parallel root layout.
  const lang = await documentLang();
  return (
    <html lang={lang} className="h-full antialiased">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLdStringify({
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: "Puêr",
              url: "https://puer.im",
              // Converted for the same reason `generateMetadata` is a function:
              // `inLanguage` already said zh-TW here while the description was
              // still simplified, which is worse than either alone — a crawler
              // is told the page is traditional and handed simplified text as
              // the proof.
              description:
                lang === "zh-TW" ? convertText(JSONLD_DESCRIPTION) : JSONLD_DESCRIPTION,
              inLanguage: lang,
              potentialAction: {
                "@type": "SearchAction",
                target: {
                  "@type": "EntryPoint",
                  urlTemplate: "https://puer.im/forum?q={search_term_string}",
                },
                "query-input": "required name=search_term_string",
              },
            }),
          }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-stone-50">{children}</body>
    </html>
  );
}
