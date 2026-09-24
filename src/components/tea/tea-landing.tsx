import Link from "next/link";
import { TeaList } from "./tea-list";
import { sortByHeat, type TeaListRow } from "@/lib/tea-query";
import { safeJsonLdStringify } from "@/lib/json-ld";

export type Crumb = { name: string; path: string };

/**
 * P1-2 聚合落地页外壳：品牌 / 生熟 / 年份三类页共用。
 *
 * 结构固定为「面包屑 → H1 → 导语 → 同类目兄弟页内链 → 茶品列表」，
 * 目的是给搜索引擎一个能承接「大益 普洱茶」「熟茶」类大词的静态入口，
 * 同时用兄弟页内链把 152 个经典茶档案织成可爬行的链接图谱。
 * 每页配 BreadcrumbList（可见导航与 JSON-LD 同源，不造假层级）。
 */
export function TeaLanding({
  crumbs,
  h1,
  intro,
  siblings,
  siblingsLabel,
  teas,
}: {
  crumbs: Crumb[];
  h1: string;
  intro: string;
  siblings: { label: string; path: string; count?: number }[];
  siblingsLabel: string;
  teas: TeaListRow[];
}) {
  return (
    <div className="max-w-5xl mx-auto px-4 md:px-8 py-6 md:py-10">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLdStringify({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: crumbs.map((c, i) => ({
              "@type": "ListItem",
              position: i + 1,
              name: c.name,
              item: `https://puer.im${c.path}`,
            })),
          }),
        }}
      />

      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        {crumbs.map((c, i) => (
          <span key={c.path}>
            {i > 0 && <span className="mx-2">/</span>}
            {i === crumbs.length - 1 ? (
              <span className="text-stone-600">{c.name}</span>
            ) : (
              <Link href={c.path} className="hover:text-amber-700 transition">{c.name}</Link>
            )}
          </span>
        ))}
      </nav>

      <div className="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-xl p-5 md:p-7 mb-5">
        <h1 className="text-2xl md:text-3xl font-serif font-bold text-amber-900">{h1}</h1>
        <p className="text-sm md:text-base text-stone-600 leading-relaxed mt-3 whitespace-pre-line">{intro}</p>
      </div>

      {siblings.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-6 text-xs">
          <span className="text-stone-400">{siblingsLabel}</span>
          {siblings.map((s) => (
            <Link
              key={s.path}
              href={s.path}
              className="px-2.5 py-1 rounded-full bg-white text-stone-600 border border-stone-200 hover:border-amber-300 hover:text-amber-800 transition"
            >
              {s.label}
              {s.count != null && <span className="text-stone-400 ml-1">{s.count}</span>}
            </Link>
          ))}
        </div>
      )}

      <h2 className="text-lg font-serif font-bold text-stone-800 mb-3">
        茶品档案 <span className="text-sm font-normal text-stone-400">共 {teas.length} 款</span>
      </h2>
      {teas.length > 0 ? (
        <TeaList teas={sortByHeat(teas)} />
      ) : (
        <p className="text-center text-stone-400 py-16 bg-white rounded-xl border border-dashed border-stone-200 text-sm">
          该分类下暂无经典茶品收录
        </p>
      )}
    </div>
  );
}
