import path from "path";

/**
 * Filesystem roots for upload-related storage.
 *
 * Two tiers, and the distinction is a security boundary:
 *
 *  PUBLIC_UPLOADS_ROOT  — everything the site is allowed to serve over HTTP.
 *    nginx aliases a handful of subdirectories of it (see deploy/nginx/puer.conf)
 *    and Next.js serves everything else under public/ automatically. The
 *    /uploads/[...path] fallback route reads from it too.
 *
 *  PRIVATE_ROOT        — everything that must NEVER be reachable over HTTP.
 *    It lives OUTSIDE public/, so neither Next.js's static handler nor the
 *    fallback route can serve it: there is no route that maps /app/private
 *    into the URL space.
 *
 * Why the split exists (audit 2026-10-21):
 *
 *  - The unwatermarked video twins ("videos-raw") are the admin-only download
 *    source for the 小红书 publishing pipeline. While they lived under
 *    public/uploads/videos-raw/, anyone who guessed a filename could pull the
 *    original at /uploads/videos-raw/<name>.mp4 — the watermark was bypassable.
 *    They also were not bind-mounted, so every container recreate silently
 *    deleted them (the admin download fell back to the watermarked copy).
 *
 *  - Chunk staging (".tmp") holds half-written uploads. Under public/ they
 *    were fetchable at /uploads/.tmp/<userId>/<uploadId>/<n>, and because the
 *    directory was not bind-mounted the per-user temp quota restarted from
 *    zero on every deploy.
 *
 * Both are now bind-mounted from the host and live under PRIVATE_ROOT.
 */

export const PUBLIC_ROOT = path.join(process.cwd(), "public");

export const PUBLIC_UPLOADS_ROOT = path.join(PUBLIC_ROOT, "uploads");

/** Public videos directory (watermarked copies served to the front-end). */
export const PUBLIC_VIDEOS_ROOT = path.join(PUBLIC_UPLOADS_ROOT, "videos");

export const PRIVATE_ROOT = path.join(process.cwd(), "private");

/** Chunk staging for in-progress uploads. Swept by upload-cleanup.ts. */
export const CHUNK_ROOT = path.join(PRIVATE_ROOT, "uploads-tmp");

/** Unwatermarked video originals. Admin download only — never web-served. */
export const RAW_VIDEOS_ROOT = path.join(PRIVATE_ROOT, "videos-raw");

/**
 * True when `candidate` resolves inside `root`. Used to assert that no
 * private path is ever handed to a public-serving code path.
 */
export function isInside(root: string, candidate: string): boolean {
  const rootResolved = path.resolve(root);
  const target = path.resolve(candidate);
  return target === rootResolved || target.startsWith(rootResolved + path.sep);
}
