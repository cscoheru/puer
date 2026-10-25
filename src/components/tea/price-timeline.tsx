import {
  PRICE_DISCLAIMER,
  type PriceTimelineEntry,
} from "@/lib/price-snapshot";

/**
 * 茶品页的「价格区间」时间线（F5 · PRD v0.3 §7 Phase 4）。
 *
 * ## 为什么只显示区间
 *
 * 普洱的「行情」不是一个数 —— 同一款茶在不同渠道/年份/品相下的成交价能差
 * 一截。显示一个点价等于编一个精确的数字；显示**区间**才是事实。
 *
 * ## 为什么与站长线对照
 *
 * PRD F5：「价格区间时间线与站长线叠加，可对照『价格涨跌』与『转化状态』」。
 * 每条快照带一个「当时的阶段」—— 那是这条价格记录之前最近的一条站长线
 * 记录的阶段，于是「价格跌了、转化也走到下坡了」这类事一眼能看出来。
 *
 * ## 公开显示
 *
 * 与站长线同一口径（站长手记向的公开内容）。**不做估值**（PRD 明确：
 * 「不做茶仓估值」），也不给任何买卖建议。
 */
export default function PriceTimelineView({
  entries,
}: {
  entries: PriceTimelineEntry[];
}) {
  if (entries.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="text-lg md:text-2xl font-serif font-bold text-stone-800 mb-1">
        价格区间
      </h2>
      <p className="text-xs text-stone-400 mb-4">
        站长手工整理的成交区间（只录区间不录点值）。
        {PRICE_DISCLAIMER}
      </p>

      <ol className="relative border-l-2 border-stone-200 ml-2 space-y-4">
        {entries.map((e) => (
          <li key={e.snapshot.id} className="pl-4 relative">
            <span className="absolute -left-[7px] top-1.5 w-3 h-3 rounded-full bg-amber-200 border-2 border-white" />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-sm text-stone-500">
                {e.snapshot.snapshotDate}
              </span>
              <span className="text-base font-semibold text-stone-800">
                {e.range}
              </span>
              {e.changePct !== null && (
                <span
                  className={`text-xs font-medium ${
                    e.changePct > 0
                      ? "text-red-600"
                      : e.changePct < 0
                        ? "text-green-600"
                        : "text-stone-400"
                  }`}
                >
                  {e.changePct > 0 ? "▲" : e.changePct < 0 ? "▼" : ""}{" "}
                  {Math.abs(e.changePct)}%
                </span>
              )}
            </div>
            <p className="text-xs text-stone-400 mt-0.5">
              来源：{e.snapshot.sourceLabel}
              {e.snapshot.note ? ` · ${e.snapshot.note}` : ""}
              {e.stageLabel && ` · 当时的阶段：${e.stageLabel}`}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
