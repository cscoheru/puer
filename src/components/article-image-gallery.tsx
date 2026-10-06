"use client";

import { useState, useEffect } from "react";
import { LockedWallOverlay } from "@/components/tea/locked-tip";

/**
 * 帖子详情页图片墙 — 渲染 article.images 中未内联进 content 的图片。
 * maxVisible: 最多显示几张图片，超出部分显示会员锁定遮罩（默认 3）。
 */
export default function ArticleImageGallery({
  images,
  maxVisible = 3,
}: {
  images: string[];
  maxVisible?: number;
}) {
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    if (!lightbox) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    document.addEventListener("keydown", handler);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = "";
    };
  }, [lightbox]);

  if (images.length === 0) return null;

  const visible = images.slice(0, maxVisible);
  const hiddenCount = images.length - maxVisible;

  return (
    <div className="mt-4">
      <div className="image-gallery">
        {visible.map((src) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={src}
            src={src}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onClick={() => setLightbox(src)}
            className="cursor-zoom-in"
          />
        ))}
      </div>

      {/* 会员锁定遮罩：茶品详情页同款风格 */}
      {hiddenCount > 0 && (
        <div className="relative mt-2 overflow-hidden rounded-lg">
          <div className="image-gallery opacity-30 blur-[2px] pointer-events-none select-none">
            {images.slice(maxVisible, maxVisible + 3).map((src) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={src} src={src} alt="" referrerPolicy="no-referrer" />
            ))}
          </div>
          <LockedWallOverlay hiddenCount={hiddenCount} />
        </div>
      )}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightbox(null)}
        >
          <button
            className="absolute top-4 right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/30 text-white text-xl hover:bg-black/50 transition"
            onClick={() => setLightbox(null)}
            aria-label="关闭"
          >
            ✕
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox}
            alt=""
            className="max-h-[90vh] max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}