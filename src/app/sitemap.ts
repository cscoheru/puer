import { prisma } from "@/lib/prisma";
import { absImageUrl } from "@/lib/seo-image";
import { extractFeedImages } from "@/lib/forum-feed-server";
import { loadFacets } from "@/lib/tea-landing-server";
import { MetadataRoute } from "next";

export const dynamic = "force-dynamic";

const BASE = "https://puer.im";

/** P0-5：帖子图走 extractFeedImages（content ∪ images 字段）——茶记管线帖的
 *  图只在 images 字段，旧逻辑只从 content 正则提导致这些帖子在 sitemap 全无图
 *  （违反 AGENTS.md R26 规则 1）。取合并后的前 6 张绝对化去重。 */
function articleImages(a: { content: string; images: string[] | null }): string[] {
  const merged = extractFeedImages(a).images;
  const out: string[] = [];
  for (const u of merged) {
    const abs = absImageUrl(u);
    if (abs && !out.includes(abs)) out.push(abs);
    if (out.length >= 6) break;
  }
  return out;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  let articlePages: MetadataRoute.Sitemap = [];
  let teaPages: MetadataRoute.Sitemap = [];
  let boardPages: MetadataRoute.Sitemap = [];
  let hubPages: MetadataRoute.Sitemap = [];

  try {
    const boards = await prisma.board.findMany({ select: { slug: true } });
    boardPages = boards.map((b) => ({
      url: `${BASE}/forum/${b.slug}`,
      lastModified: now,
      changeFrequency: "daily" as const,
      priority: 0.7,
    }));
  } catch { /* skip */ }

  try {
    // P2-R11 SEO：图片 sitemap 扩展（image:image）——Google Images 收录
    const articles = await prisma.article.findMany({
      // P0-5 补正：原条件要求 content 非空，会把「图只在 images 字段」的管线帖
      // 整个排除在 sitemap 之外（线上实测有 1 篇命中）。extractFeedImages 已能
      // 合并两路图源，故改成「正文或图库任一非空」——两者皆空才算空壳页。
      where: {
        status: "published",
        visibility: { not: "private" },
        OR: [{ content: { not: "" } }, { images: { isEmpty: false } }],
      },
      select: { id: true, updatedAt: true, content: true, images: true },
      take: 1000,
      orderBy: { createdAt: "desc" },
    });
    articlePages = articles.map((a) => {
      const images = articleImages(a);
      return {
        url: `${BASE}/forum/thread/${a.id}`,
        lastModified: a.updatedAt,
        changeFrequency: "weekly" as const,
        priority: 0.6,
        ...(images.length > 0 ? { images } : {}),
      };
    });
  } catch { /* skip */ }

  try {
    // P2-R23 茶品库隐藏：sitemap 只收录经典普洱茶详情页（非经典私人档案不进搜索引擎）
    const teas = await prisma.tea.findMany({
      where: { deletedAt: null, isClassic: true },
      select: { id: true, updatedAt: true, coverImage: true },
      take: 1000,
    });
    teaPages = teas.map((t) => {
      const img = absImageUrl(t.coverImage);
      return {
        url: `${BASE}/tea/${t.id}`,
        lastModified: t.updatedAt,
        changeFrequency: "monthly" as const,
        priority: 0.5,
        ...(img ? { images: [img] } : {}),
      };
    });
  } catch { /* skip */ }

  try {
    // P1-2：品牌/生熟/年份聚合页——承接「大益 普洱茶」「熟茶」「2003 普洱」类大词。
    // 准入判据直接取 loadFacets()，与落地页 notFound 闸门、/tea 的分类导航**同源**。
    // 原先三处各写一遍阈值逻辑，就漂移出了「漏掉『未知』品牌」的 404 面包屑。
    //
    // lastModified 用「该类目下最新一款茶的 updatedAt」，不用 `now`：本 sitemap 是
    // force-dynamic，恒等于抓取时刻的时间戳会被 Google 判定为无信息量，并连带削弱
    // 文章页/茶品页上真实 updatedAt 的可信度。
    const { brands, types, years } = await loadFacets();
    hubPages = [
      ...brands.map((b) => ({
        url: `${BASE}/tea/brand/${encodeURIComponent(b.brand)}`,
        lastModified: b.latest ?? now,
        changeFrequency: "weekly" as const,
        priority: 0.75,
      })),
      ...types.map((t) => ({
        url: `${BASE}/tea/type/${t.key}`,
        lastModified: t.latest ?? now,
        changeFrequency: "weekly" as const,
        priority: 0.8,
      })),
      ...years.map((y) => ({
        url: `${BASE}/tea/year/${y.year}`,
        lastModified: y.latest ?? now,
        changeFrequency: "weekly" as const,
        priority: 0.6,
      })),
    ];
  } catch (e) {
    // 这里是"降级可接受"的少数场景：sitemap 少几条只是少一个发现提示，
    // 落地页本身仍在（内部有互链），不像页面 404 那样会被移出索引。
    // 但按 AGENTS.md R26 规则 3，跳过必须留痕，不许静默。
    console.error("[sitemap] hub pages skipped:", e);
  }

  // /encyclopedia 已 307 至 /forum（P0-1 移除，避免浪费抓取预算）
  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE, lastModified: now, changeFrequency: "hourly", priority: 1.0 },
    { url: `${BASE}/forum`, lastModified: now, changeFrequency: "hourly", priority: 0.9 },
    { url: `${BASE}/forum/classics`, lastModified: now, changeFrequency: "daily", priority: 0.8 },
    // P1-1 后 /tea 公开（只列经典茶），重新成为 200 页
    { url: `${BASE}/tea`, lastModified: now, changeFrequency: "daily", priority: 0.8 },
    { url: `${BASE}/exchange`, lastModified: now, changeFrequency: "daily", priority: 0.7 },
  ];

  return [...staticPages, ...hubPages, ...boardPages, ...articlePages, ...teaPages];
}
