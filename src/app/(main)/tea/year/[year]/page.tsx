import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TeaLanding, type Crumb } from "@/components/tea/tea-landing";
import { loadClassicTeas, loadFacets } from "@/lib/tea-landing-server";
import { TEA_TYPE_LABELS, YEAR_RANGE } from "@/lib/tea-query";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ year: string }>;
}): Promise<Metadata> {
  const year = parseInt((await params).year, 10);
  if (!Number.isFinite(year)) {
    return { title: "年份普洱 - 普洱茶库", robots: { index: false, follow: true } };
  }
  return {
    title: `${year}年普洱茶 - ${year}年经典茶品档案大全（生茶/熟茶）`,
    description: `${year}年普洱茶档案大全：收录${year}年生产的经典生茶与熟茶，含品种档案、历年品鉴转化记录、口感评分与东和行情快照。`,
    keywords: [`${year}年普洱茶`, `${year}年普洱生茶`, `${year}年普洱熟茶`, "年份普洱茶"],
    alternates: { canonical: `/tea/year/${year}` },
  };
}

export default async function TeaYearPage({
  params,
}: {
  params: Promise<{ year: string }>;
}) {
  const year = parseInt((await params).year, 10);
  if (!Number.isFinite(year) || year < YEAR_RANGE.min || year > YEAR_RANGE.max) notFound();

  const facets = await loadFacets();
  const self = facets.years.find((y) => y.year === year);
  if (!self) notFound();

  const teas = await loadClassicTeas({ year });

  const crumbs: Crumb[] = [
    { name: "品茶论坛", path: "/forum" },
    { name: "茶品库", path: "/tea" },
    { name: `${year}年普洱`, path: `/tea/year/${year}` },
  ];

  const rawCount = teas.filter((t) => t.type === "raw").length;
  const ripeCount = teas.filter((t) => t.type === "ripe").length;
  // `self.count` 来自 facet 全量统计，而 raw/ripe 是从上限 200 条的列表里数的；
  // 两者只在列表覆盖全量时才可比（现有最大年份 21 款，远低于上限）。
  const coversAll = teas.length >= self.count;
  const breakdown = coversAll ? `（生茶 ${rawCount} 款、熟茶 ${ripeCount} 款）` : "";

  const intro = [
    `本页汇总本站已建档的 ${year} 年生产的经典普洱茶，共 ${self.count} 款${breakdown}，按热度排序。`,
    `同一年份出品、不同唛号与厂牌的茶，风味与市场表现差异可能很大：生茶看用料等级与仓储起点，熟茶看渥堆发酵水平。点击任一茶品可查看品种档案、历年品鉴记录与东和行情快照。`,
  ].join("\n\n");

  // 相邻年份内链（爬虫可沿年份轴遍历）
  const neighbours = facets.years
    .filter((y) => y.year !== year)
    .sort((a, b) => Math.abs(a.year - year) - Math.abs(b.year - year))
    .slice(0, 8)
    .sort((a, b) => b.year - a.year);

  return (
    <TeaLanding
      crumbs={crumbs}
      h1={`${year}年普洱茶 · 经典茶品档案`}
      intro={intro}
      siblingsLabel="相邻年份："
      siblings={neighbours.map((y) => ({
        label: `${y.year}年`,
        path: `/tea/year/${y.year}`,
        count: y.count,
      }))}
      teas={teas}
    />
  );
}
