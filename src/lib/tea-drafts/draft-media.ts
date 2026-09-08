/**
 * Draft media (images/video) sync policy — pure logic, unit-tested.
 *
 * When an admin edits a draft's `images[]`, the stored slideshow `videoUrl`
 * (generated from those images at creation time) must be kept consistent:
 *  - images unchanged            → keep the existing video untouched
 *  - images changed, count >= 4  → regenerate the slideshow from the new set
 *  - images changed, count < 4   → clear the video (a stale slideshow showing
 *                                  deleted images is worse than none)
 * Reordering counts as a change: the slideshow plays images in order.
 */

import { isAllowedMediaUrl } from "./assemble.ts";

export type VideoSyncPlan = "keep" | "regenerate" | "clear";

export function planVideoSync(
  currentImages: string[],
  nextImages: string[]
): VideoSyncPlan {
  const cur = Array.isArray(currentImages) ? currentImages : [];
  const next = Array.isArray(nextImages) ? nextImages : [];
  if (cur.join(" ") === next.join(" ")) return "keep";
  return next.length >= 4 ? "regenerate" : "clear";
}

export const MAX_DRAFT_IMAGES = 100;

/** Admin-edited draft images: every entry must pass the media allowlist. */
export function validateDraftImages(
  raw: unknown
): { ok: true; images: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "images 必须是数组" };
  if (raw.length > MAX_DRAFT_IMAGES) {
    return { ok: false, error: `图片数量超过上限 ${MAX_DRAFT_IMAGES}` };
  }
  for (const item of raw) {
    if (typeof item !== "string") {
      return { ok: false, error: "images 数组内存在非字符串项" };
    }
    if (!isAllowedMediaUrl(item)) {
      return { ok: false, error: `不允许的图片地址: ${item.slice(0, 80)}` };
    }
    // Defense in depth beyond isAllowedMediaUrl: these URLs are passed to
    // generateSlideshowVideo which resolves them under public/ — reject any
    // traversal or protocol-relative form up front.
    if (item.includes("..") || item.startsWith("//")) {
      return { ok: false, error: `不允许的图片地址: ${item.slice(0, 80)}` };
    }
  }
  return { ok: true, images: raw };
}
