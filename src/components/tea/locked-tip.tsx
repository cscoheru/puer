"use client";

import { useEffect, useRef, useState } from "react";

/** P2-R22 付费会员区预埋：非付费用户点击受限内容时的权限提示。
 *  提示气泡 2.5s 自动消失；文案统一「你暂时没有查看权限」。 */

function useAutoHideTip(ms = 2500) {
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const trigger = () => {
    setShow(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setShow(false), ms);
  };

  return { show, trigger };
}

/** 行内锁定入口（如转化档案条目的「查看完整品鉴」） */
export function LockedTip({ label, className }: { label: string; className?: string }) {
  const { show, trigger } = useAutoHideTip();
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          trigger();
        }}
        className={
          className ??
          "inline-flex items-center gap-1 text-xs text-stone-400 hover:text-amber-700 transition cursor-pointer"
        }
      >
        🔒 {label}
      </button>
      {show && (
        <span className="absolute left-0 bottom-full mb-1.5 z-20 whitespace-nowrap px-2.5 py-1 rounded-md bg-stone-800 text-white text-xs shadow-lg">
          你暂时没有查看权限
          <span className="absolute left-3 top-full border-4 border-transparent border-t-stone-800" />
        </span>
      )}
    </span>
  );
}

/** 图片墙渐变遮罩层：虚化锁定区，点击提示无权限（覆盖层拦截所有图片点击） */
export function LockedWallOverlay({ hiddenCount }: { hiddenCount: number }) {
  const { show, trigger } = useAutoHideTip();
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="会员专享图片库"
      onClick={trigger}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          trigger();
        }
      }}
      className="absolute inset-0 z-10 cursor-pointer select-none"
      style={{ background: "linear-gradient(to bottom, rgba(255,255,255,0) 30%, rgba(255,255,255,0.55) 62%, rgba(255,255,255,0.92) 100%)" }}
    >
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 pb-3">
        <span className="px-3 py-1.5 rounded-full bg-stone-900/80 text-white text-xs font-medium backdrop-blur-sm">
          🔒 会员专享 · 完整图片库仅付费会员可见
        </span>
        {hiddenCount > 0 && (
          <span className="text-xs text-stone-500">
            还有 {hiddenCount} 张图 ·{" "}
            <span className="text-amber-700 font-medium underline underline-offset-2">开通会员查看</span>
          </span>
        )}
      </div>
      {show && (
        <span className="absolute left-1/2 -translate-x-1/2 bottom-12 z-20 whitespace-nowrap px-2.5 py-1 rounded-md bg-stone-800 text-white text-xs shadow-lg">
          你暂时没有查看权限
        </span>
      )}
    </div>
  );
}
