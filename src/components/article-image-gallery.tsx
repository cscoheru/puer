"use client";

import { useState, useEffect } from "react";

/**
 * P2-R26：帖子详情页图片墙 — 渲染 article.images 中未内联进 content 的图片。
 * 茶记自动帖（tasting-draft）的图片存独立 images 字段、content 纯文字，
 * ForumContent 只渲染 content，因此需要这个补充 gallery（含 lightbox）。
 * 样式复用 globals.css 的 .image-gallery（与正文内联图片墙一致）。
 */
export default function ArticleImageGallery({ images }: { images: string[] }) {
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

  return (
    <div className="mt-4">
      <div className="image-gallery">
        {images.map((src) => (
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
