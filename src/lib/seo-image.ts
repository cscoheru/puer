import { prisma } from "@/lib/prisma";

/** P2-R11 SEO：把库内相对图片 URL 绝对化为 https://puer.im/...，
 *  供 JSON-LD / og:image / 图片 sitemap 使用（Google 要求绝对 URL）。 */
export function absImageUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  let s = u.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    // 库内 localhost 开发地址归一为生产域
    return s.replace(/^http?:\/\/localhost:\d+/i, "https://puer.im");
  }
  if (s.startsWith("//")) return `https:${s}`;
  if (s.startsWith("/")) return `https://puer.im${s}`;
  return `https://puer.im/${s}`;
}

/** 从帖子/笔记 HTML content 中提取第一张图（绝对化后） */
export function firstImageFromHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  return absImageUrl(html.match(/<img[^>]+src="([^">]+)"/)?.[1]);
}
