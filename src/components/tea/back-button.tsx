"use client";

import { useRouter } from "next/navigation";

/**
 * 茶品详情页顶部的「返回」。
 *
 * 刻意不渲染面包屑：层级路径（品茶论坛/茶品库/品牌/生熟）会暴露站内结构，
 * 产品上也不需要——用户从哪个页面进来就回哪个页面（侧栏茶卡、经典普洱、
 * 论坛内链等来源各不相同，面包屑给的是站点视角，返回给的才是用户视角）。
 *
 * 直达（新标签打开/外站跳入，history 里没有上一页）时退回 /tea 聚合页，
 * 避免 router.back() 直接退出站点。
 */
export default function TeaBackButton() {
  const router = useRouter();

  const goBack = () => {
    if (window.history.length > 1) router.back();
    else router.push("/tea");
  };

  return (
    <button
      type="button"
      onClick={goBack}
      className="inline-flex items-center gap-1 text-sm text-stone-500 hover:text-amber-700 transition mb-4"
    >
      <span aria-hidden>←</span> 返回
    </button>
  );
}
