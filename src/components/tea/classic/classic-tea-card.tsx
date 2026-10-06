import Link from "next/link";
import { firstTeaImage, type TeaListRow } from "@/lib/tea-query";
import { parseMarket } from "@/lib/market-info";

const NEW_THRESHOLD_DAYS = 30;

/** 经典茶品卡片：封面图 + 品牌标签 + 名称 + 年份 + 类型 + 品鉴数 */
export default function ClassicTeaCard({ tea }: { tea: TeaListRow }) {
  const image = firstTeaImage(tea);
  const market = parseMarket(tea.marketInfo);
  const daysSince = (Date.now() - new Date(tea.createdAt).getTime()) / (1000 * 60 * 60 * 24);
  const isNew = daysSince <= NEW_THRESHOLD_DAYS;

  return (
    <Link
      href={`/tea/${tea.id}`}
      className="block bg-white rounded-xl border border-stone-200 overflow-hidden hover:shadow-md hover:border-amber-300 transition group"
    >
      {/* Image */}
      <div className="aspect-[4/3] bg-stone-100 relative overflow-hidden">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt={tea.name} loading="lazy" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-3xl text-stone-300">🍵</div>
        )}
        {isNew && (
          <span className="absolute top-2 left-2 text-[0.625rem] px-1.5 py-0.5 bg-green-500 text-white rounded-full font-medium">
            新收录
          </span>
        )}
      </div>
      {/* Info */}
      <div className="p-3">
        <h3 className="font-medium text-stone-800 text-sm truncate group-hover:text-amber-800 transition">
          {tea.name}
        </h3>
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          <span className="text-[0.625rem] px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded">{tea.brand}</span>
          <span className="text-[0.625rem] px-1.5 py-0.5 bg-stone-100 text-stone-500 rounded">
            {tea.year}{tea.batch ? `-${tea.batch}` : ""}
          </span>
          <span className={`text-[0.625rem] px-1.5 py-0.5 rounded ${tea.type === "raw" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
            {tea.type === "raw" ? "生" : "熟"}
          </span>
        </div>
        <p className="text-xs text-stone-400 mt-2">
          {tea.tastingNoteCount > 0 ? `${tea.tastingNoteCount} 篇品鉴` : "建档中"}
          {tea.avgRating != null && ` · ★${tea.avgRating.toFixed(1)}`}
          {market?.price && ` · ${market.price}`}
        </p>
      </div>
    </Link>
  );
}