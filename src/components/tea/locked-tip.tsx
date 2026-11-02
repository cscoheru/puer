"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

/**
 * 受限内容的入口提示。
 *
 * 2026-11-02 起口径变了：**摘要公开、正文要登录**（原先是「付费会员专享」的
 * 占位，而站内根本没有付费体系 —— 那套文案一直在骗人）。
 * 所以这里给了两种形态：
 *   - 传 `href` → 直接给一个登录链接（点就去登录，不弹气泡）；
 *   - 不传 → 仍是气泡提示（「你暂时没有查看权限」），2.5s 自动消失。
 *
 * 将来真接上付费体系，把 `href` 换成「开通会员」链接即可，文案一处改。
 */

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

/** 行内锁定入口（如转化档案条目的「查看完整品鉴」）。 */
export function LockedTip({
  label,
  className,
  href,
  tip = "你暂时没有查看权限",
}: {
  label: string;
  className?: string;
  /** 给了就渲染成链接（点即跳转，不弹气泡）。 */
  href?: string;
  tip?: string;
}) {
  const { show, trigger } = useAutoHideTip();
  const cls =
    className ??
    "inline-flex items-center gap-1 text-xs text-stone-400 hover:text-amber-700 transition cursor-pointer";

  if (href) {
    return (
      <Link href={href} className={cls}>
        🔒 {label}
      </Link>
    );
  }

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
        className={cls}
      >
        🔒 {label}
      </button>
      {show && (
        <span className="absolute left-0 bottom-full mb-1.5 z-20 whitespace-nowrap px-2.5 py-1 rounded-md bg-stone-800 text-white text-xs shadow-lg">
          {tip}
          <span className="absolute left-3 top-full border-4 border-transparent border-t-stone-800" />
        </span>
      )}
    </span>
  );
}

/** 图片墙渐变遮罩层：虚化锁定区，点击提示无权限（覆盖层拦截所有图片点击） */
export function LockedWallOverlay({
  hiddenCount,
  href,
  title = "🔒 会员专享 · 完整图片库仅付费会员可见",
  cta = "开通会员查看",
}: {
  hiddenCount: number;
  /** 给了就把底部 CTA 变成链接（登录后可见）。 */
  href?: string;
  /** 遮罩上那行标题 —— 各调用点口径不同，别写死在组件里。 */
  title?: string;
  cta?: string;
}) {
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
          {title}
        </span>
        {hiddenCount > 0 && (
          <span className="text-xs text-stone-500">
            还有 {hiddenCount} 张图 ·{" "}
            {href ? (
              <Link href={href} className="text-amber-700 font-medium underline underline-offset-2">
                {cta}
              </Link>
            ) : (
              <span className="text-amber-700 font-medium underline underline-offset-2">{cta}</span>
            )}
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
