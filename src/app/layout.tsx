import type { Metadata } from "next";
import "./globals.css";
import { safeJsonLdStringify } from "@/lib/json-ld";

export const metadata: Metadata = {
  metadataBase: new URL("https://puer.im"),
  title: {
    default: "Puêr — 以茶会友，品鉴真味",
    template: "%s | Puêr",
  },
  description: "Puêr — 普洱茶爱好者社区。品茶交流、茶叶评测、普洱茶知识分享、茶友互动的专业论坛。发现好茶，分享品茶心得。",
  keywords: ["普洱茶", "普洱论坛", "品茶", "茶友社区", "茶叶评测", "普洱茶交流", "puer tea", "品茶论坛", "茶文化"],
  alternates: { canonical: "/" },
  openGraph: {
    title: "Puêr — 以茶会友，品鉴真味",
    description: "中老期普洱茶爱好者社区，品鉴笔记、茶品百科、茶友交流",
    type: "website",
    locale: "zh_CN",
    siteName: "Puêr",
    url: "https://puer.im",
  },
  twitter: {
    card: "summary_large_image",
    title: "Puêr",
    description: "中老期普洱茶爱好者社区",
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

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLdStringify({
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: "Puêr",
              url: "https://puer.im",
              description: "中老期普洱茶爱好者社区 — 品鉴笔记、茶品百科、茶友交流",
              inLanguage: "zh-CN",
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
