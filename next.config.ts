import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
    ],
  },
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [
      {
        source: "/sitemap.xml",
        headers: [
          { key: "Cache-Control", value: "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      // 用户进入 puer.im 直接进论坛 — 不再走营销首页（V1 改版）
      {
        source: "/",
        destination: "/forum",
        permanent: true, // 308 永久重定向
      },
      // /tw 是繁体树的入口，但没有 page.tsx —— 不重定向的话这个功能的主推 URL
      // 直接 404（而 /tw/forum 正常）。与上面 / 的处理保持同一层、同一语义：
      // 都是"入口 → 论坛首屏"，只是繁简两棵树各有一条。
      {
        source: "/tw",
        destination: "/tw/forum",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
