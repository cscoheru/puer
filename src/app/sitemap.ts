import { prisma } from "@/lib/prisma";
import { absImageUrl, firstImageFromHtml } from "@/lib/seo-image";
import { MetadataRoute } from "next";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = "https://puer.im";

  const staticPages: MetadataRoute.Sitemap = [
    { url: baseUrl, lastModified: new Date(), changeFrequency: "hourly", priority: 1.0 },
    { url: `${baseUrl}/forum`, lastModified: new Date(), changeFrequency: "hourly", priority: 0.9 },
    { url: `${baseUrl}/tea`, lastModified: new Date(), changeFrequency: "daily", priority: 0.8 },
    { url: `${baseUrl}/exchange`, lastModified: new Date(), changeFrequency: "daily", priority: 0.7 },
    { url: `${baseUrl}/encyclopedia`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.6 },
  ];

  let articlePages: MetadataRoute.Sitemap = [];
  let teaPages: MetadataRoute.Sitemap = [];
  let boardPages: MetadataRoute.Sitemap = [];

  try {
    const boards = await prisma.board.findMany({ select: { slug: true } });
    boardPages = boards.map((b) => ({
      url: `${baseUrl}/forum/${b.slug}`,
      lastModified: new Date(),
      changeFrequency: "daily" as const,
      priority: 0.7,
    }));
  } catch { /* skip */ }

  try {
    // P2-R11 SEO：图片 sitemap 扩展（image:image）——Google Images 收录
    // 帖子首图与茶品档案图的主要通道。content 取回后正则提首图并绝对化。
    const articles = await prisma.article.findMany({
      where: { status: "published", content: { not: "" }, visibility: { not: "private" } },
      select: { id: true, updatedAt: true, content: true },
      take: 1000,
      orderBy: { createdAt: "desc" },
    });
    articlePages = articles.map((a) => ({
      url: `${baseUrl}/forum/thread/${a.id}`,
      lastModified: a.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.6,
      ...(firstImageFromHtml(a.content) ? { images: [firstImageFromHtml(a.content) as string] } : {}),
    }));
  } catch { /* skip */ }

  try {
    const teas = await prisma.tea.findMany({ select: { id: true, updatedAt: true, coverImage: true }, take: 1000 });
    teaPages = teas.map((t) => ({
      url: `${baseUrl}/tea/${t.id}`,
      lastModified: t.updatedAt,
      changeFrequency: "monthly" as const,
      priority: 0.5,
      ...(absImageUrl(t.coverImage) ? { images: [absImageUrl(t.coverImage) as string] } : {}),
    }));
  } catch { /* skip */ }

  return [...staticPages, ...boardPages, ...articlePages, ...teaPages];
}
