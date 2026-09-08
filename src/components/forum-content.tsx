"use client";

import { useRef, useState, useEffect } from "react";
import { sanitizeHtml } from "@/lib/sanitize";

interface ForumContentProps {
  html: string;
  className?: string;
}

export default function ForumContent({ html, className = "" }: ForumContentProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const children = Array.from(el.children);

    // Group consecutive sibling <img> into gallery wrappers
    let walkBuffer: Element[] = [];
    for (const node of children) {
      if (node.tagName === 'IMG') {
        walkBuffer.push(node);
      } else {
        if (walkBuffer.length > 1) {
          const gallery = document.createElement('div');
          gallery.className = 'image-gallery';
          walkBuffer.forEach((img, idx) => {
            if (idx === 0) {
              img.replaceWith(gallery);
              gallery.appendChild(img);
            } else {
              gallery.appendChild(img);
            }
          });
        }
        walkBuffer = [];
      }
    }
    if (walkBuffer.length > 1) {
      const gallery = document.createElement('div');
      gallery.className = 'image-gallery';
      walkBuffer.forEach((img, idx) => {
        if (idx === 0) {
          img.replaceWith(gallery);
          gallery.appendChild(img);
        } else {
          gallery.appendChild(img);
        }
      });
    }

    // Fix external images: set referrerPolicy and fallback to proxy on error
    const allImgs = el.querySelectorAll<HTMLImageElement>("img");
    const isSameOrigin = (src: string) =>
      src.startsWith("/") || src.startsWith(window.location.origin);
    for (const img of allImgs) {
      img.referrerPolicy = "no-referrer";
      if (isSameOrigin(img.src)) {
        // Same-origin uploads: retry once, then show placeholder
        img.addEventListener("error", function handleLocalError() {
          if (!img.dataset.retriedLocal) {
            img.dataset.retriedLocal = "1";
            img.src = img.src;
          } else {
            img.alt = "图片加载失败";
            img.style.display = "inline-block";
            img.style.width = "120px";
            img.style.height = "80px";
            img.style.background = "#f5f5f4";
            img.style.border = "1px dashed #d6d3d1";
            img.style.borderRadius = "6px";
            img.style.padding = "8px";
            img.style.fontSize = "12px";
            img.style.color = "#a8a29e";
            img.style.objectFit = "contain";
            img.removeAttribute("src");
            img.removeEventListener("error", handleLocalError);
          }
        });
      } else if (img.src.startsWith("http://") && !img.src.startsWith("http://localhost")) {
        const httpsSrc = img.src.replace("http://", "https://");
        img.addEventListener("error", function retryHttps() {
          if (img.dataset.retriedHttps) {
            img.src = `https://images.weserv.nl/?url=${encodeURIComponent(httpsSrc)}`;
            img.removeEventListener("error", retryHttps);
          } else {
            img.src = httpsSrc;
            img.dataset.retriedHttps = "1";
          }
        });
      }
    }
  }, [html]);

  // Close on Escape
  useEffect(() => {
    if (!lightbox) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [lightbox]);

  // Prevent body scroll when lightbox open
  useEffect(() => {
    if (lightbox) {
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [lightbox]);

  const handleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "IMG" && !target.closest("a")) {
      setLightbox((target as HTMLImageElement).src);
    }
  };

  return (
    <>
      <div
        ref={ref}
        className={`prose prose-stone prose-sm md:prose-base max-w-none forum-content ${className}`}
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}
        onClick={handleClick}
      />

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
          <img
            src={lightbox}
            alt=""
            className="max-h-[90vh] max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
