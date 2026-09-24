import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TeaLanding, type Crumb } from "@/components/tea/tea-landing";
import { loadClassicTeas, loadFacets } from "@/lib/tea-landing-server";

export const dynamic = "force-dynamic";

/** 品牌导语：主力厂牌给一句定制背景，其余用通用模板（不编造史实） */
const BRAND_BLURB: Record<string, string> = {
  大益: "大益（原勐海茶厂）是当代普洱熟茶工艺的奠基者，7542、7572 被视作生茶与熟茶的标杆配方，改制前后的唛号茶是收藏市场的核心标的。",
  下关: "下关沱茶以「沱」形制与烟香风格著称，甲级沱、销法沱等下关经典在西南与藏区流通历史悠久。",
  福今: "福今以班章料与大白菜系列闻名，是 2000 年代高端定制茶的代表厂牌之一。",
  今大福: "今大福延续班章路线，以「大福」系列承接福今时期的用料风格。",
  陈升号: "陈升号主打老班章纯料，是山头茶品牌化的早期推动者之一。",
};

function decodeBrand(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ brand: string }>;
}): Promise<Metadata> {
  const brand = decodeBrand((await params).brand);
  return {
    title: `${brand}普洱茶 - ${brand}经典茶品档案大全（生茶/熟茶）`,
    description: `${brand}普洱茶档案大全：收录${brand}各年份经典生茶与熟茶，含品种档案、历年品鉴记录、口感评分与东和行情快照，茶友可持续发布转化跟进。`,
    keywords: [`${brand}普洱茶`, `${brand}生茶`, `${brand}熟茶`, `${brand}茶品档案`, "普洱茶品牌"],
    alternates: { canonical: `/tea/brand/${encodeURIComponent(brand)}` },
  };
}

export default async function TeaBrandPage({
  params,
}: {
  params: Promise<{ brand: string }>;
}) {
  const brand = decodeBrand((await params).brand);
  if (!brand) notFound();

  const facets = await loadFacets();
  // 与 sitemap / 导航同阈值：茶品太少的品牌不建页，避免薄内容
  const self = facets.brands.find((b) => b.brand === brand);
  if (!self) notFound();

  const teas = await loadClassicTeas({ brand });

  const crumbs: Crumb[] = [
    { name: "品茶论坛", path: "/forum" },
    { name: "茶品库", path: "/tea" },
    { name: `${brand}普洱茶`, path: `/tea/brand/${encodeURIComponent(brand)}` },
  ];

  const intro = [
    BRAND_BLURB[brand] ??
      `${brand}是普洱茶库中收录较完整的厂牌之一，本站已建档 ${self.count} 款经典茶品。`,
    `本页按热度汇总 ${brand} 的经典茶品档案（共 ${self.count} 款）：点击任一茶品可查看品种档案、历年品鉴转化记录与东和行情快照。茶品页内可发布跟进帖，记录开汤表现与仓储转化。`,
  ].join("\n\n");

  return (
    <TeaLanding
      crumbs={crumbs}
      h1={`${brand}普洱茶 · 经典茶品档案`}
      intro={intro}
      siblingsLabel="其他厂牌："
      siblings={facets.brands
        .filter((b) => b.brand !== brand)
        .slice(0, 10)
        .map((b) => ({
          label: b.brand,
          path: `/tea/brand/${encodeURIComponent(b.brand)}`,
          count: b.count,
        }))}
      teas={teas}
    />
  );
}
