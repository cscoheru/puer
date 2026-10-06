"use client";

import { useRef, useState, useEffect } from "react";
import { sanitizeHtml } from "@/lib/sanitize";

interface ForumContentProps {
  html: string;
  className?: string;
  maxImages?: number; // 限制最多显示几张图片，超出显示会员锁定
}

export default function ForumContent({ html, className = "", maxImages }: ForumContentProps) {
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

  // Image limiting: hide images beyond maxImages and show member lock overlay
  useEffect(() => {
    if (!maxImages) return;
    const el = ref.current;
    if (!el) return;
    const allImgs = Array.from(el.querySelectorAll<HTMLImageElement>("img"));
    if (allImgs.length <= maxImages) return;

    // Hide images beyond the limit
    for (let i = maxImages; i < allImgs.length; i++) {
      allImgs[i].style.display = "none";
      allImgs[i].dataset.locked = "1";
    }

    // Also hide their parent gallery divs if they're inside one
    for (let i = maxImages; i < allImgs.length; i++) {
      const parent = allImgs[i].parentElement;
      if (parent?.classList.contains("image-gallery")) {
        const visibleChildren = Array.from(parent.children).filter(
          (c) => (c as HTMLElement).style?.display !== "none"
        );
        if (visibleChildren.length === 0) {
          parent.style.display = "none";
        }
      }
    }

    // Add lock overlay after the last visible image
    const hiddenCount = allImgs.length - maxImages;
    const overlay = document.createElement("div");
    overlay.className = "member-image-lock";
    overlay.innerHTML = `
      <div style="position:relative;padding:24px 16px;margin-top:8px;border-radius:8px;overflow:hidden;background:#fafaf9;">
        <div style="display:flex;align-items:center;justify-content:center;gap:8px;">
          <span style="padding:6px 12px;border-radius:9999px;background:rgba(41,37,36,0.8);color:white;font-size:12px;font-weight:500;backdrop-filter:blur(8px);">
            🔒 会员专享 · 完整图片库仅付费会员可见
          </span>
        </div>
        <div style="text-align:center;margin-top:8px;font-size:12px;color:#78716c;">
          还有 ${hiddenCount} 张图 · <span style="color:#b45309;font-weight:500;text-decoration:underline;">开通会员查看</span>
        </div>
      </div>
    `;
    // Insert after the last visible image's container
    const lastVisible = allImgs[maxImages - 1];
    const insertAfter = lastVisible.closest(".image-gallery") || lastVisible;
    insertAfter.parentNode?.insertBefore(overlay, insertAfter.nextSibling);
  }, [html, maxImages]);

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
