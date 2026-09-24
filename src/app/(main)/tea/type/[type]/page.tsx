import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TeaLanding, type Crumb } from "@/components/tea/tea-landing";
import { loadClassicTeas, loadFacets } from "@/lib/tea-landing-server";
import { normalizeTeaType, TEA_TYPE_LABELS } from "@/lib/tea-query";

export const dynamic = "force-dynamic";

const TYPE_INTRO: Record<"raw" | "ripe", { h1: string; title: string; desc: string; body: string }> = {
  raw: {
    h1: "生普洱茶 · 生普档案大全",
    title: "生普洱茶 - 生普经典茶品档案大全（大益/下关/福今）",
    desc: "生普洱茶档案大全：收录大益、下关、福今等厂牌各年份生普经典茶品，含品种档案、历年品鉴转化记录、口感评分与东和行情快照。",
    body:
      "生普（生茶）指鲜叶经杀青、揉捻、晒干后压制成型的普洱茶，不经人工渥堆发酵，靠时间与仓储自然转化。\n\n" +
      "新茶的刺激性来自茶多酚与咖啡碱，随年份增长逐步氧化聚合，汤色由黄绿转橙红、香气由青味转陈香，这一过程通常被称为「转化」。因此生普的年份、仓储条件（干仓/湿仓）与唛号共同决定了它的风味走向与市场定位。\n\n" +
      "本页汇总本站已建档的生普经典茶品，按热度排序。点击进入茶品页可查看品种档案、历年品鉴记录与行情快照。",
  },
  ripe: {
    h1: "熟普洱茶 · 熟普档案大全",
    title: "熟普洱茶 - 熟普经典茶品档案大全（大益7572/下关销法沱）",
    desc: "熟普洱茶档案大全：收录大益 7572、下关销法沱等经典熟普，含品种档案、历年品鉴记录、口感评分与东和行情快照。",
    body:
      "熟普（熟茶）指晒青毛茶经渥堆发酵后压制成型的普洱茶。1973 年渥堆工艺定型后，熟茶以「红浓透亮、醇厚顺滑」的即饮特性成为日常消耗的主力。\n\n" +
      "评判熟茶主要看发酵度是否均匀、有无堆味、汤感厚薄与回甘表现。7572、7262 等唛号配方历经数十年市场检验，是理解熟茶风格的基准。\n\n" +
      "本页汇总本站已建档的熟普经典茶品，按热度排序。点击进入茶品页可查看品种档案、历年品鉴记录与行情快照。",
  },
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ type: string }>;
}): Promise<Metadata> {
  const key = normalizeTeaType((await params).type);
  if (!key) return { title: "生熟分类 - 普洱茶库", robots: { index: false, follow: true } };
  const c = TYPE_INTRO[key];
  return {
    title: c.title,
    description: c.desc,
    keywords: [`${TEA_TYPE_LABELS[key]}普洱茶`, TEA_TYPE_LABELS[key], "普洱茶档案", "经典普洱"],
    alternates: { canonical: `/tea/type/${key}` },
  };
}

export default async function TeaTypePage({
  params,
}: {
  params: Promise<{ type: string }>;
}) {
  const key = normalizeTeaType((await params).type);
  if (!key) notFound();

  const facets = await loadFacets();
  if (!facets.types.some((t) => t.key === key)) notFound();

  const teas = await loadClassicTeas({ type: key });
  const c = TYPE_INTRO[key];
  const other = facets.types.find((t) => t.key !== key);

  const crumbs: Crumb[] = [
    { name: "品茶论坛", path: "/forum" },
    { name: "茶品库", path: "/tea" },
    { name: TEA_TYPE_LABELS[key], path: `/tea/type/${key}` },
  ];

  return (
    <TeaLanding
      crumbs={crumbs}
      h1={c.h1}
      intro={c.body}
      siblingsLabel="其他分类："
      siblings={[
        ...(other ? [{ label: TEA_TYPE_LABELS[other.key], path: `/tea/type/${other.key}`, count: other.count }] : []),
        ...facets.brands.slice(0, 8).map((b) => ({
          label: b.brand,
          path: `/tea/brand/${encodeURIComponent(b.brand)}`,
          count: b.count,
        })),
      ]}
      teas={teas}
    />
  );
}
