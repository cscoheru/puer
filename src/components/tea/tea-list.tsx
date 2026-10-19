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

/**
 * 卡片网格（茶品库 /tea 用）。
 *
 * 茶品库是**全集**：经典茶公开可读，非经典茶（在建档/私人档案）的详情要求登录
 * （`/tea/[id]` 会把未登录者 redirect 到 `/login`）。
 *
 * `loggedIn` 决定两件事：
 *  - 非经典卡片**是不是链接**。未登录时渲染成不可点的 `<div>` 而不是 `<Link>` ——
 *    匿名访问者（含 Googlebot）看到的 HTML 里因此没有任何指向非经典档案的链接，
 *    不会顺着几百个链接撞一整片登录页。而登录用户拿到的是可点的完整全集。
 *  - 非经典卡片的角标文案（「登录可见」/「非经典」）。
 */
export function TeaGrid({ teas, loggedIn = false }: { teas: TeaListRow[]; loggedIn?: boolean }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {teas.map((tea) => {
        const clickable = loggedIn || tea.isClassic;
        const cardClass = clickable
          ? "block bg-white rounded-xl border border-stone-200 overflow-hidden hover:shadow-md hover:border-amber-300 transition group"
          : "block bg-white rounded-xl border border-stone-200 overflow-hidden";

        const inner = (
          <>
            <div className="relative">
              {/* 匿名看非经典卡片时，把「品鉴笔记图」这一级 fallback 摘掉：
                  firstTeaImage 的第三级会取最近品鉴笔记的图，那些可能来自私密茶记
                  或已翻私密的跟进帖镜像 —— 笔记本身要求登录，列表却把图渲染进了
                  公开 HTML，等于绕过详情闸门。经典茶公开，保留三级链。 */}
              <TeaThumb
                tea={
                  !clickable
                    ? { ...tea, tastingNotes: [] }
                    : tea
                }
                className="aspect-square w-full"
                rounded="rounded-none"
                icon="text-4xl"
              />
              {tea.isClassic ? (
                <span className="absolute top-1.5 left-1.5 text-[0.625rem] px-1.5 py-0.5 rounded bg-amber-800/85 text-amber-50">
                  🏵️ 经典
                </span>
              ) : (
                <span className="absolute top-1.5 left-1.5 text-[0.625rem] px-1.5 py-0.5 rounded bg-stone-700/80 text-stone-100">
                  {loggedIn ? "非经典" : "登录可见"}
                </span>
              )}
            </div>
            <div className="p-3">
              <h2
                className={`font-medium text-stone-800 text-sm truncate ${
                  clickable ? "group-hover:text-amber-800 transition" : ""
                }`}
              >
                {tea.name}
              </h2>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                <span className="text-[0.625rem] px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded">{tea.brand}</span>
                <span className="text-[0.625rem] px-1.5 py-0.5 bg-stone-100 text-stone-500 rounded">{tea.year}</span>
                <span className={`text-[0.625rem] px-1.5 py-0.5 rounded ${tea.type === "raw" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                  {tea.type === "raw" ? "生" : "熟"}
                </span>
              </div>
              {/* 品鉴数/评分是按全部笔记聚合的（含非公开笔记），匿名的非经典卡片不展示，
                  否则会泄露「存在几篇非公开跟进帖」这一事实。经典茶公开，正常展示。 */}
              {clickable && tea.tastingNoteCount > 0 && (
                <p className="text-xs text-stone-400 mt-2">
                  {tea.tastingNoteCount} 篇品鉴
                  {tea.avgRating != null && <span> · ★ {tea.avgRating.toFixed(1)}</span>}
                </p>
              )}
            </div>
          </>
        );

        return clickable ? (
          <Link key={tea.id} href={`/tea/${tea.id}`} className={cardClass}>
            {inner}
          </Link>
        ) : (
          <div key={tea.id} className={cardClass} title="登录后可查看完整档案">
            {inner}
          </div>
        );
      })}
    </div>
  );
}
