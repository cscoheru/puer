"use client";

import {
  STORAGE_ANCHORS,
  STORAGE_DEFAULT_SCORE,
  STORAGE_SCORE_MAX,
  STORAGE_SCORE_MIN,
  normalizeStorageScore,
  storageScalePercent,
  storageScoreLabel,
} from "@/lib/cellar";

/**
 * 拇指直径（px）。
 *
 * 原生 range 的拇指在轨道上**居中**，两端各留半个拇指宽的余量 ——
 * 所以刻度行也要按这个量内缩，「45」的刻度才会落在拇指滑到最左时的中心。
 * 实测（Chromium，340px 轨道）：拇指中心在 10.75px / 329px，
 * 与内缩 10px 的刻度完全对上。
 */
const THUMB_PX = 20;

/** 拇指在 32px 高的输入框里居中所需的上下内边距（(32 - 轨道 6) / 2）。 */
const SLIDER_PADDING_PX = 13;

/**
 * 刻度行 —— **模块级算一次**。
 *
 * 它只依赖 `STORAGE_ANCHORS`（模块常量），与组件状态无关。拖动滑块时
 * 浏览器每移动一像素就发一次 input 事件、组件就重渲染一次，这行刻度
 * 不该跟着重新分配。
 *
 * 位置一律走 `storageScalePercent`：它把 [最小值, 最大值] 线性映射到
 * 0–1，刻度按它定位就能对上滑块。
 *
 * 首尾两个**名称**贴边对齐，中间的居中 —— 否则「标准偏干」会被容器裁掉一半。
 * **数字**一律居中，因为它才是对刻度的那个标记。
 */
const STORAGE_TICKS = STORAGE_ANCHORS.flatMap((a, i) => {
  const pct = storageScalePercent(a.score);
  // 锚点分数由常量表自带，永远合法；真出现 null 说明常量表坏了，
  // 那就不画这个刻度 —— 绝不拿 0 顶替（0 是「值在最左端」的意思）。
  if (pct === null) return [];
  const labelShift =
    i === 0
      ? "translate-x-0"
      : i === STORAGE_ANCHORS.length - 1
        ? "-translate-x-full"
        : "-translate-x-1/2";
  return [
    {
      score: a.score,
      label: a.label,
      left: `${pct * 100}%`,
      labelShift,
    },
  ];
});

/**
 * 仓储评分标尺（连续数轴，不是四个档位）。
 *
 * ## 为什么不是四个按钮
 *
 * 之前用的是 `storage-anchor-picker.tsx`：45/50/55/60 四个按钮，只能选锚点，
 * 选不出 47 或 58。但 PRD 只给了**四个参考点**，不是四个取值 ——
 * 2026-10-24 站长明确纠正：「实际是一个数轴，左边最低 45，右边最高 60，
 * 中间任何一个状态都可以」。
 *
 * 所以这里用一根可拖动的滑块，锚点退化成**刻度**，当前值同时显示
 * 「数字 + 最近锚点名」（47 → 「47 · 标准偏干」），既精确又不用背锚点含义。
 *
 * ## 为什么轨道要自己画
 *
 * 原生 range 的 `accent-color` 会把「已填充的轨道」和「拇指」涂成**同一个
 * 颜色** —— 滑块就只剩一条没有刻度的色条，看不出精确位置在哪。
 * 所以这里把轨道和填充拆成两层绝对定位的 div 自绘，拇指保留原生滑块
 * （键盘、触摸、读屏行为全都在，只换皮），样式见 `globals.css` 的
 * `.cellar-storage-slider`。
 *
 * ## 为什么是纯受控的（组件内部没有任何 state）
 *
 * 滑块位置 = `value ?? STORAGE_DEFAULT_SCORE`，没有本地副本。
 * 之前试过「本地 pos + 渲染期同步外部 value」的两份状态，结果是：
 *   - 拖动时父组件每次重渲染都会多走一遍被丢弃的渲染；
 *   - 「清除记录」之后拇指停在用户最后拖到的位置，与「未记录」自相矛盾。
 * 受控版本没有这些问题：控件指着的数**永远**就是那个数的值。
 *
 * 两个地方要用它（添加茶、换仓），所以仍然**只有这一份实现** ——
 * 锚点集合在 `src/lib/cellar.ts` 的 `STORAGE_ANCHORS`。
 */
export default function StorageSlider({
  value,
  onChange,
  className = "",
}: {
  value: number | null;
  onChange: (score: number | null) => void;
  className?: string;
}) {
  // 未记录：没有填充、拇指用灰色 —— 一眼看出「还没记」，
  // 而不是「恰好记成了标准仓」。
  const pct = value === null ? 0 : (storageScalePercent(value) ?? 0);
  const recorded = value !== null;

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span className="text-xs text-stone-500">
          仓储状态（{STORAGE_SCORE_MIN} 最干 → {STORAGE_SCORE_MAX} 最湿）
        </span>
        <span className="text-xs">
          {recorded ? (
            <span className="text-amber-800 font-medium">
              {storageScoreLabel(value)}
            </span>
          ) : (
            <span className="text-stone-400">{storageScoreLabel(null)}</span>
          )}
        </span>
      </div>

      <div className="relative pb-7">
        <div className="relative h-8">
          {/* 未填充的轨道 */}
          <div
            className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-stone-200"
            style={{ marginInline: THUMB_PX / 2 }}
          />
          {/* 已填充的部分 —— 右端落在拇指中心 */}
          {recorded && (
            <div
              className="pointer-events-none absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-amber-700"
              style={{
                left: THUMB_PX / 2,
                width: `calc(${pct} * (100% - ${THUMB_PX}px))`,
              }}
            />
          )}

          <input
            type="range"
            min={STORAGE_SCORE_MIN}
            max={STORAGE_SCORE_MAX}
            step={1}
            value={value ?? STORAGE_DEFAULT_SCORE}
            onChange={(e) => {
              // 走规范化的那一份：越界/非整数/被篡改的 DOM 值一律不进父状态。
              // 服务端的 zod 与 DB 的 CHECK 也会挡，但那是最后一道，不是第一道。
              const n = normalizeStorageScore(e.target.value);
              if (n === null) {
                console.warn("[cellar] 仓储评分取值非法，已忽略", e.target.value);
                return;
              }
              onChange(n);
            }}
            aria-label="仓储评分"
            // 读屏软件会念原生滑块的值；未记录时 DOM 里是 50，但真实状态是
            // 「没记」—— aria-valuetext 把它说清楚。
            aria-valuetext={recorded ? storageScoreLabel(value) : storageScoreLabel(null)}
            className="cellar-storage-slider relative w-full h-8"
            style={{
              paddingBlock: SLIDER_PADDING_PX,
              ["--cellar-thumb" as string]: recorded ? "#b45309" : "#d6d3d1",
            }}
          />
        </div>

        {/* 刻度行：数字对齐刻度，名称首尾贴边 */}
        <div
          className="pointer-events-none absolute inset-x-0 top-[27px] h-9"
          style={{ marginInline: THUMB_PX / 2 }}
        >
          {STORAGE_TICKS.map((t) => (
            <span key={t.score} className="absolute top-0" style={{ left: t.left }}>
              <span className="absolute left-0 -translate-x-1/2 text-[0.65rem] text-stone-400 tabular-nums">
                {t.score}
              </span>
              <span
                className={`absolute left-0 top-4 ${t.labelShift} text-[0.65rem] text-stone-500 whitespace-nowrap`}
              >
                {t.label}
              </span>
            </span>
          ))}
        </div>
      </div>

      {recorded && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-[0.65rem] text-stone-500 hover:text-stone-700 min-h-[44px] inline-flex items-center -my-3.5 px-1"
        >
          清除记录
        </button>
      )}
    </div>
  );
}
