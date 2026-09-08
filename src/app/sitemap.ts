import { prisma } from "@/lib/prisma";
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
    const articles = await prisma.article.findMany({
      where: { status: "published", content: { not: "" }, visibility: { not: "private" } },
      select: { id: true, updatedAt: true },
      take: 1000,
      orderBy: { createdAt: "desc" },
    });
    articlePages = articles.map((a) => ({
      url: `${baseUrl}/forum/thread/${a.id}`,
      lastModified: a.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    }));
  } catch { /* skip */ }

  try {
    const teas = await prisma.tea.findMany({ select: { id: true, updatedAt: true }, take: 1000 });
    teaPages = teas.map((t) => ({
      url: `${baseUrl}/tea/${t.id}`,
      lastModified: t.updatedAt,
      changeFrequency: "monthly" as const,
      priority: 0.5,
    }));
  } catch { /* skip */ }

  return [...staticPages, ...boardPages, ...articlePages, ...teaPages];
}
