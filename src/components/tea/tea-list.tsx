import Link from "next/link";
import { parseMarket } from "@/lib/market-info";
import type { TeaListRow } from "@/lib/tea-query";
import { TeaThumb } from "./tea-thumb";

/** 吧内/落地页茶品列表行：封面缩略 + 档案信息 + 行情价 */
export function TeaList({ teas, recentIds }: { teas: TeaListRow[]; recentIds?: Set<string> }) {
  return (
    <div className="space-y-2">
      {teas.map((tea) => {
        const market = parseMarket(tea.marketInfo);
        return (
          <Link
            key={tea.id}
            href={`/tea/${tea.id}`}
            className="flex items-center gap-3 p-3 bg-white rounded-xl border border-stone-200 hover:border-amber-300 hover:shadow-sm transition group"
          >
            <TeaThumb tea={tea} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="font-medium text-stone-800 text-sm truncate group-hover:text-amber-800 transition">
                  {tea.name}
                </h2>
                {recentIds?.has(tea.id) && (
                  <span className="text-[0.625rem] px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full">更新中</span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                <span className="text-[0.625rem] px-1.5 py-0.5 bg-stone-100 text-stone-500 rounded">{tea.brand}</span>
                <span className="text-[0.625rem] px-1.5 py-0.5 bg-stone-100 text-stone-500 rounded">
                  {tea.year}{tea.batch ? `-${tea.batch}` : ""}
                </span>
                <span className={`text-[0.625rem] px-1.5 py-0.5 rounded ${tea.type === "raw" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                  {tea.type === "raw" ? "生" : "熟"}
                </span>
              </div>
              <p className="text-xs text-stone-400 mt-1.5">
                {tea.tastingNoteCount > 0 ? `${tea.tastingNoteCount} 篇品鉴` : "建档中"}
                {tea.avgRating != null && ` · ★${tea.avgRating.toFixed(1)}`}
                {tea._count.articles > 0 && ` · ${tea._count.articles} 条跟进`}
                {market?.price && ` · ${market.price}`}
              </p>
            </div>
            <div className="shrink-0 text-right hidden sm:block">
              {market ? (
                <>
                  <p className="text-sm font-semibold text-amber-800">{market.price}</p>
                  <p className="text-[0.625rem] text-stone-300 mt-0.5">{market.source || "东和茶库"}</p>
                </>
              ) : (
                <p className="text-[0.625rem] text-stone-300">暂无行情</p>
              )}
              <p className="text-[0.625rem] text-amber-700 group-hover:translate-x-0.5 transition mt-1.5">查看档案 ›</p>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

/** 卡片网格（茶品库 /tea 用） */
export function TeaGrid({ teas }: { teas: TeaListRow[] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {teas.map((tea) => (
        <Link
          key={tea.id}
          href={`/tea/${tea.id}`}
          className="block bg-white rounded-xl border border-stone-200 overflow-hidden hover:shadow-md hover:border-amber-300 transition group"
        >
          <TeaThumb tea={tea} className="aspect-square w-full" rounded="rounded-none" icon="text-4xl" />
          <div className="p-3">
            <h2 className="font-medium text-stone-800 text-sm truncate group-hover:text-amber-800 transition">
              {tea.name}
            </h2>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              <span className="text-[0.625rem] px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded">{tea.brand}</span>
              <span className="text-[0.625rem] px-1.5 py-0.5 bg-stone-100 text-stone-500 rounded">{tea.year}</span>
              <span className={`text-[0.625rem] px-1.5 py-0.5 rounded ${tea.type === "raw" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                {tea.type === "raw" ? "生" : "熟"}
              </span>
            </div>
            {tea.tastingNoteCount > 0 && (
              <p className="text-xs text-stone-400 mt-2">
                {tea.tastingNoteCount} 篇品鉴
                {tea.avgRating != null && <span> · ★ {tea.avgRating.toFixed(1)}</span>}
              </p>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}
