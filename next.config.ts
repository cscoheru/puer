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
    ];
  },
};

export default nextConfig;
