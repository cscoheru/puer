/**
 * Pure upload security policy — no filesystem, no network, no framework deps.
 *
 * Every path the upload route writes to is derived from user-controlled input
 * (uploadId, userId, category, declared sizes). Historically the route did a
 * raw `path.join(CHUNK_DIR, uploadId)` and then `rm(that, {recursive:true})`
 * on complete — a directory-traversal + recursive-delete primitive. This module
 * exists so those decisions are made in one audited, unit-tested place and the
 * route never builds a path or trusts a bound on its own.
 *
 * Design rules enforced here:
 *  - Identifiers (uploadId, userId) are validated against strict patterns and
 *    NEVER interpolated into a path before validation.
 *  - All derived paths are produced by buildContainedPath(), which uses two
 *    independent layers: a per-segment traversal/separator rejection and a
 *    resolved containment check with a separator-aware prefix guard (so
 *    "/uploads/foo2" is not accepted as inside "/uploads/foo").
 *  - File type is chosen from a server-side MIME allowlist; the extension is
 *    derived from the validated MIME, never from a client string.
 *  - All numeric bounds (chunk index, total chunks, sizes) are range-checked.
 */

import path from "path";

export type FileKind = "image" | "video";

export type UploadErrorCode =
  | "bad_upload_id"
  | "bad_user_id"
  | "bad_chunk_index"
  | "bad_total_chunks"
  | "unsupported_type"
  | "bad_category"
  | "size_too_large"
  | "path_escape"
  | "chunk_out_of_range"
  | "chunks_incomplete"
  | "not_owner"
  | "manifest_missing"
  | "manifest_corrupt"
  | "quota_exceeded"
  | "too_many_concurrent";

export class UploadPolicyError extends Error {
  code: UploadErrorCode;
  constructor(code: UploadErrorCode, message?: string) {
    super(message ?? code);
    this.name = "UploadPolicyError";
    this.code = code;
  }
}

// ── Identifier validation ────────────────────────────────────────────────
// Client generates 16 random bytes → 32 lowercase hex chars. Anything else is
// rejected before it can reach the filesystem. This is the single most
// important defense: the production bug trusted an arbitrary header here.
const UPLOAD_ID_RE = /^[a-f0-9]{32}$/;
// Auth user ids are cuid/uuid-like. Allow alnum, underscore, hyphen only —
// never "/", "\", "..", spaces, or percent encodings.
const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function parseUploadId(raw: unknown): string {
  if (typeof raw !== "string" || !UPLOAD_ID_RE.test(raw)) {
    throw new UploadPolicyError("bad_upload_id", "invalid upload id");
  }
  return raw;
}

export function sanitizeUserId(raw: unknown): string {
  if (typeof raw !== "string" || !USER_ID_RE.test(raw) || raw.includes("..")) {
    throw new UploadPolicyError("bad_user_id", "invalid user id");
  }
  return raw;
}

// ── Path containment ────────────────────────────────────────────────────
/**
 * Build an absolute path under `root` from validated segments. Throws
 * path_escape if any segment could escape the root. Two layers:
 *  (1) reject segments containing separators, NUL, or traversal tokens — this
 *      stops absolute injection and `..` before resolution;
 *  (2) resolve and verify the result is root itself or a proper child using a
 *      separator-aware prefix check (guards against "/x/foo" vs "/x/foo2").
 */
export function buildContainedPath(root: string, ...segments: string[]): string {
  const rootResolved = path.resolve(root);
  for (const seg of segments) {
    if (typeof seg !== "string" || seg.length === 0) {
      throw new UploadPolicyError("path_escape", "empty path segment");
    }
    if (
      seg.includes("/") ||
      seg.includes("\\") ||
      seg.includes("\0") ||
      seg === ".." ||
      seg === "."
    ) {
      throw new UploadPolicyError("path_escape", "unsafe path segment");
    }
  }
  const candidate = path.resolve(rootResolved, ...segments);
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + path.sep)) {
    throw new UploadPolicyError("path_escape", "path escapes upload root");
  }
  return candidate;
}

// ── File type ────────────────────────────────────────────────────────────
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/heic", "image/heif"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

// Fixed MIME → extension map. The extension is never taken from the client.
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export function classifyFileType(mime: unknown): { kind: FileKind; mime: string } {
  if (typeof mime !== "string") {
    throw new UploadPolicyError("unsupported_type", "missing file type");
  }
  // Exact, lowercase match only. No trim, no case-folding generosity: a header
  // of "image/jpeg " or "IMAGE/JPEG" is a strong attacker signal.
  if (IMAGE_MIMES.has(mime)) return { kind: "image", mime };
  if (VIDEO_MIMES.has(mime)) return { kind: "video", mime };
  throw new UploadPolicyError("unsupported_type", "unsupported file type");
}

export function deriveExtension(mime: string): string {
  const ext = MIME_EXT[mime];
  if (!ext) throw new UploadPolicyError("unsupported_type", "unsupported file type");
  return ext;
}

// ── Category → destination subdirectory ──────────────────────────────────
// subDir is ALWAYS one of these fixed strings, never raw input.
const VALID_CATEGORIES = new Set(["", "session", "avatar", "inventory"]);

export function parseCategory(raw: unknown): "" | "session" | "avatar" | "inventory" {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string" || !VALID_CATEGORIES.has(raw)) {
    throw new UploadPolicyError("bad_category", "invalid category");
  }
  return raw as "" | "session" | "avatar" | "inventory";
}

export function categoryToSubdir(category: "" | "session" | "avatar" | "inventory", kind: FileKind): string {
  switch (category) {
    case "session": return "sessions";
    case "avatar": return "avatars";
    case "inventory": return "inventory";
    default: return kind === "video" ? "videos" : "forum";
  }
}

// ── Numeric bounds ────────────────────────────────────────────────────────
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
// Hard per-chunk body cap. Client targets 1MB; allow 2MB headroom. The route
// must enforce this on the stream, not trust Content-Length.
export const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
// 200 × 1MB = 200MB of headroom over the 100MB video cap; bounds a malicious
// client that declares a huge totalChunks.
export const MAX_TOTAL_CHUNKS = 200;
export const MAX_CONCURRENT_UPLOADS_PER_USER = 3;
export const MAX_USER_TEMP_BYTES = 300 * 1024 * 1024;

export function maxBytesForKind(kind: FileKind): number {
  return kind === "video" ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;
}

export function parseTotalChunks(raw: unknown): number {
  const n = parseNonNegativeInt(raw, "bad_total_chunks");
  if (n < 1 || n > MAX_TOTAL_CHUNKS) {
    throw new UploadPolicyError("bad_total_chunks", "invalid total chunk count");
  }
  return n;
}

/** Validate a chunk index against a declared total. */
export function parseChunkIndex(raw: unknown, totalChunks: number): number {
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_TOTAL_CHUNKS) {
    throw new UploadPolicyError("bad_total_chunks", "invalid total chunk count");
  }
  const idx = parseNonNegativeInt(raw, "chunk_out_of_range");
  if (idx >= totalChunks) {
    throw new UploadPolicyError("chunk_out_of_range", "chunk index out of range");
  }
  return idx;
}

/**
 * Parse a non-negative integer from a number or a digit-only string. Rejects
 * floats, NaN, ±Infinity, negatives, signs, hex, whitespace, and empty. `code`
 * lets the caller attribute the failure to its own domain (totalChunks vs
 * chunkIndex vs manifest).
 */
function parseNonNegativeInt(raw: unknown, code: UploadErrorCode): number {
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string" && /^[0-9]+$/.test(raw)) {
    n = Number(raw);
  } else {
    throw new UploadPolicyError(code, "not a non-negative integer");
  }
  if (!Number.isInteger(n) || n < 0) {
    throw new UploadPolicyError(code, "not a non-negative integer");
  }
  return n;
}

export function assertUploadSize(kind: FileKind, bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > maxBytesForKind(kind)) {
    throw new UploadPolicyError("size_too_large", "file exceeds size limit");
  }
}

// ── Chunk-set completeness (used by complete) ────────────────────────────
export interface ChunkSetResult {
  complete: boolean;
  missing: number[]; // indices in [0, totalChunks) not present (≤ first 16, for diagnostics)
}

/**
 * Given the set of chunk indices present on disk and the manifest's declared
 * totalChunks, determine whether the upload is complete and contiguous.
 * Duplicate and out-of-range indices in `present` are ignored (never trusted).
 */
export function verifyContiguousChunks(present: Iterable<number>, totalChunks: number): ChunkSetResult {
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_TOTAL_CHUNKS) {
    throw new UploadPolicyError("bad_total_chunks", "invalid total chunk count");
  }
  const seen = new Set<number>();
  for (const idx of present) {
    if (Number.isInteger(idx) && idx >= 0 && idx < totalChunks) seen.add(idx);
  }
  const missing: number[] = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!seen.has(i)) {
      missing.push(i);
      if (missing.length >= 16) break;
    }
  }
  return { complete: missing.length === 0, missing };
}

/** Fixed list of chunk filenames a complete upload is allowed to touch. */
export function expectedChunkNames(totalChunks: number): string[] {
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_TOTAL_CHUNKS) {
    throw new UploadPolicyError("bad_total_chunks", "invalid total chunk count");
  }
  const names: string[] = [];
  for (let i = 0; i < totalChunks; i++) names.push(String(i));
  return names;
}

// ── Manifest ──────────────────────────────────────────────────────────────
// Written atomically on the first chunk; loaded and owner-checked on every
// subsequent chunk, GET, and complete. Binds the immutable upload metadata so
// complete cannot re-trust mutable client headers.
export interface UploadManifest {
  ownerId: string;
  uploadId: string;
  kind: FileKind;
  mime: string;
  category: "" | "session" | "avatar" | "inventory";
  subDir: string;
  totalChunks: number;
  totalBytes: number;
  createdAt: string; // ISO timestamp, set by caller (route) — kept as string here
}

export const MANIFEST_FILENAME = "manifest.json";

export function serializeManifest(m: UploadManifest): string {
  return JSON.stringify(m);
}

export function parseManifest(raw: unknown): UploadManifest {
  if (typeof raw !== "string") {
    throw new UploadPolicyError("manifest_corrupt", "manifest is not a string");
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new UploadPolicyError("manifest_corrupt", "manifest is not valid JSON");
  }
  if (typeof obj !== "object" || obj === null) {
    throw new UploadPolicyError("manifest_corrupt", "manifest is not an object");
  }
  const o = obj as Record<string, unknown>;
  try {
    const ownerId = sanitizeUserId(o.ownerId);
    const uploadId = parseUploadId(o.uploadId);
    const { kind, mime } = classifyFileType(o.mime);
    const category = parseCategory(o.category);
    const totalChunks = parseTotalChunks(o.totalChunks);
    const totalBytes = parseNonNegativeInt(o.totalBytes, "manifest_corrupt");
    const subDir = o.subDir;
    const createdAt = o.createdAt;
    if (typeof subDir !== "string" || subDir !== categoryToSubdir(category, kind)) {
      throw new UploadPolicyError("manifest_corrupt", "manifest subDir mismatch");
    }
    if (typeof createdAt !== "string" || createdAt.length === 0) {
      throw new UploadPolicyError("manifest_corrupt", "manifest missing createdAt");
    }
    assertUploadSize(kind, totalBytes);
    return { ownerId, uploadId, kind, mime, category, subDir, totalChunks, totalBytes, createdAt };
  } catch (e) {
    // The manifest is server-written and lives next to user-writable chunks.
    // Any field that fails policy = corruption or tampering; surface a single
    // code and preserve the underlying message for ops.
    throw new UploadPolicyError(
      "manifest_corrupt",
      e instanceof Error ? e.message : "manifest field invalid",
    );
  }
}

export function assertManifestOwner(manifest: UploadManifest, userId: string): void {
  if (manifest.ownerId !== userId) {
    throw new UploadPolicyError("not_owner", "upload belongs to another user");
  }
}
