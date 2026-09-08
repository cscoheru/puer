"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";

interface ShareButtonProps {
  title: string;
  url: string;
}

export default function ShareButton({ title, url }: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState({ top: 0, left: 0 });

  // Position the portal-rendered fixed panel just under the trigger button.
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const left = Math.min(r.left, window.innerWidth - 210);
    setCoords({ top: r.bottom + 6, left: Math.max(8, left) });
  }, [open]);

  // Close on outside click; close on scroll/resize (a fixed panel would
  // otherwise detach from the button as the page scrolls).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    }
    function close() {
      setOpen(false);
    }
    document.addEventListener("click", onDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("click", onDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  async function shareNative() {
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
      } catch {
        // user dismissed the share sheet — keep menu open, do nothing
        return;
      }
    } else {
      // 桌面浏览器无系统分享 → 复制链接兜底
      await copyLink();
    }
    setOpen(false);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const input = document.createElement("input");
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function openShare(targetUrl: string) {
    window.open(targetUrl, "_blank", "width=600,height=500,noopener,noreferrer");
    setOpen(false);
  }

  const encodedUrl = encodeURIComponent(url);
  const encodedTitle = encodeURIComponent(title);
  const itemCls =
    "w-full text-left px-3 py-2 text-sm text-stone-600 hover:bg-stone-50 flex items-center gap-2";

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 text-sm text-stone-400 hover:text-amber-600 transition"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="size-4">
          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
          <polyline points="16 6 12 2 8 6" />
          <line x1="12" y1="2" x2="12" y2="15" />
        </svg>
        <span>{copied ? "已复制" : "分享"}</span>
      </button>

      {/* Portal to <body> so the panel escapes ancestor overflow-hidden (which
          was clipping it) and any stacking context — z-[9999] tops the header. */}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            style={{ top: coords.top, left: coords.left }}
            className="fixed bg-white border border-stone-200 rounded-lg shadow-xl py-1 z-[9999] min-w-[180px]"
          >
            <button onClick={() => { copyLink(); setOpen(false); }} className={itemCls}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="size-4 shrink-0">
                <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              {copied ? "已复制!" : "复制链接"}
            </button>
            <div className="border-t border-stone-100 my-1" />
            <div className="px-3 py-1 text-[10px] text-stone-400 uppercase tracking-wider">国内平台</div>
            <button onClick={() => openShare(`https://service.weibo.com/share/share.php?url=${encodedUrl}&title=${encodedTitle}`)} className={itemCls}>
              <WeiboIcon />
              微博
            </button>
            <button onClick={() => { copyLink(); setOpen(false); }} className={itemCls}>
              <WechatIcon />
              微信（复制链接）
            </button>
            <button onClick={() => shareNative()} className={itemCls}>
              <XhsIcon />
              小红书（系统分享）
            </button>
            <button onClick={() => shareNative()} className={itemCls}>
              <ChannelsIcon />
              视频号（系统分享）
            </button>
            <button onClick={() => openShare(`https://www.douban.com/share/service?url=${encodedUrl}&name=${encodedTitle}`)} className={itemCls}>
              <DoubanIcon />
              豆瓣
            </button>
            <div className="border-t border-stone-100 my-1" />
            <div className="px-3 py-1 text-[10px] text-stone-400 uppercase tracking-wider">国际平台</div>
            <button onClick={() => openShare(`https://www.reddit.com/submit?url=${encodedUrl}&title=${encodedTitle}`)} className={itemCls}>
              <RedditIcon />
              Reddit
            </button>
            <button onClick={() => openShare(`https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`)} className={itemCls}>
              <FacebookIcon />
              Facebook
            </button>
            <button onClick={() => openShare(`https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedTitle}`)} className={itemCls}>
              <TwitterIcon />
              X / Twitter
            </button>
            {"share" in navigator && (
              <>
                <div className="border-t border-stone-100 my-1" />
                <button onClick={() => { shareNative(); }} className="w-full text-left px-3 py-2 text-sm text-stone-500 hover:bg-stone-50 flex items-center gap-2">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="size-4 shrink-0">
                    <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                  </svg>
                  更多...
                </button>
              </>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}

function WeiboIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="currentColor">
      <path d="M10.098 20.323c-3.977.391-7.414-1.406-7.672-4.02-.259-2.609 2.759-5.047 6.74-5.441 3.979-.394 7.413 1.404 7.671 4.018.259 2.6-2.759 5.049-6.739 5.443zm-1.119-6.724c-2.385.332-3.497 2.044-2.483 3.828 1.014 1.785 3.762 2.896 6.147 2.564 2.384-.332 3.497-2.043 2.483-3.828-1.014-1.784-3.762-2.896-6.147-2.564zM20.196 9.4a5.007 5.007 0 0 0-4.673-3.969.687.687 0 0 0-.096 1.37 3.638 3.638 0 0 1 3.397 2.88.686.686 0 1 0 1.372-.281z"/>
      <path d="M20.96 6.408a8.145 8.145 0 0 0-7.603-6.443.687.687 0 0 0-.093 1.37 6.776 6.776 0 0 1 6.326 5.354.686.686 0 1 0 1.37-.28z"/>
    </svg>
  );
}

function WechatIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="currentColor">
      <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05a6.329 6.329 0 0 1-.253-1.726c0-3.574 3.327-6.473 7.43-6.473.234 0 .463.014.69.032C16.518 4.806 12.952 2.188 8.691 2.188zm-2.35 4.477a1.06 1.06 0 1 1 0 2.12 1.06 1.06 0 0 1 0-2.12zm4.69 0a1.06 1.06 0 1 1 0 2.12 1.06 1.06 0 0 1 0-2.12zm4.488 4.189c-3.378 0-6.119 2.399-6.119 5.36 0 2.962 2.741 5.36 6.119 5.36a7.6 7.6 0 0 0 2.122-.3.67.67 0 0 1 .556.075l1.465.857a.25.25 0 0 0 .13.042.227.227 0 0 0 .224-.228c0-.055-.022-.11-.037-.164l-.3-1.139a.46.46 0 0 1 .165-.513C20.93 18.706 21.84 17.08 21.84 15.213c0-2.961-2.74-5.36-6.12-5.36h.01zm-2.33 3.193a.816.816 0 1 1 0 1.632.816.816 0 0 1 0-1.632zm4.69 0a.816.816 0 1 1 0 1.632.816.816 0 0 1 0-1.632z"/>
    </svg>
  );
}

function XhsIcon() {
  // 小红书品牌红 + "红"字(简化辨识;小红书无网页 share intent,仅复制链接)
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0">
      <rect width="24" height="24" rx="5" fill="#FF2442" />
      <text x="12" y="16.5" textAnchor="middle" fontSize="11" fontWeight="700" fill="white" fontFamily="sans-serif">红</text>
    </svg>
  );
}

function ChannelsIcon() {
  // 微信视频号:微信绿 + 播放三角(视频号无网页 share intent,仅复制链接)
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0">
      <rect width="24" height="24" rx="5" fill="#07c160" />
      <polygon points="10,7.5 17,12 10,16.5" fill="white" />
    </svg>
  );
}

function DoubanIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="currentColor">
      <path d="M2.4 3.6h19.2v2.4H2.4V3.6zm1.2 4.8h16.8v7.2H15v2.4h4.8v2.4H4.2v-2.4H9v-2.4H3.6V8.4zm2.4 2.4v2.4h12v-2.4H6z"/>
    </svg>
  );
}

function RedditIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="currentColor">
      <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z"/>
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="currentColor">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
    </svg>
  );
}

function TwitterIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
    </svg>
  );
}
