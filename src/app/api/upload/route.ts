import { auth } from "@/lib/auth";
import { mkdir, writeFile, readdir, rm, rename, stat, copyFile, readFile, unlink, rmdir, lstat } from "fs/promises";
import { existsSync, createWriteStream, createReadStream } from "fs";
import path from "path";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { execFile } from "child_process";
import { promisify } from "util";
import sharp from "sharp";
import { applyImageWatermark } from "@/lib/watermark";
import {
  UploadPolicyError,
  type UploadManifest,
  parseUploadId,
  sanitizeUserId,
  buildContainedPath,
  classifyFileType,
  deriveExtension,
  parseCategory,
  categoryToSubdir,
  parseTotalChunks,
  parseChunkIndex,
  assertUploadSize,
  verifyContiguousChunks,
  expectedChunkNames,
  parseManifest,
  serializeManifest,
  assertManifestOwner,
  MANIFEST_FILENAME,
  MAX_CHUNK_BYTES,
  MAX_CONCURRENT_UPLOADS_PER_USER,
  maxBytesForKind,
} from "@/lib/upload-policy";
import { maybeSweepUploadTemp } from "@/lib/upload-cleanup";

const execFileAsync = promisify(execFile);

const CHUNK_ROOT = path.join(process.cwd(), "public", "uploads", ".tmp");
const UPLOADS_ROOT = path.join(process.cwd(), "public", "uploads");

// ffmpeg is CPU-heavy; cap concurrent transcodes process-wide so one user
// cannot starve the box. 2 leaves headroom for the app + DB on the small VPS.
const FFMPEG_CONCURRENCY = 2;
let ffmpegActive = 0;
const ffmpegWaiters: Array<() => void> = [];
async function withFfmpeg<T>(fn: () => Promise<T>): Promise<T> {
  while (ffmpegActive >= FFMPEG_CONCURRENCY) {
    await new Promise<void>((resolve) => ffmpegWaiters.push(resolve));
  }
  ffmpegActive++;
  try {
    return await fn();
  } finally {
    ffmpegActive--;
    const next = ffmpegWaiters.shift();
    if (next) next();
  }
}

// In-process per-user concurrency gate. Resets on restart; the bounded TTL
// cleaner (batch 6 follow-up) is the durable backstop for abandoned uploads.
const activeUploads = new Map<string, number>();
function acquireUpload(userId: string): void {
  if ((activeUploads.get(userId) ?? 0) >= MAX_CONCURRENT_UPLOADS_PER_USER) {
    throw new UploadPolicyError("too_many_concurrent", "too many concurrent uploads");
  }
  activeUploads.set(userId, (activeUploads.get(userId) ?? 0) + 1);
}
function releaseUpload(userId: string): void {
  const n = (activeUploads.get(userId) ?? 1) - 1;
  if (n <= 0) activeUploads.delete(userId);
  else activeUploads.set(userId, n);
}

/** Map any policy/known failure to a JSON response; never leak internals. */
function policyResponse(e: unknown): Response {
  if (e instanceof UploadPolicyError) {
    console.error("[upload-policy]", e.code, e.message);
    const status =
      e.code === "not_owner" ? 403 :
      e.code === "too_many_concurrent" ? 429 :
      400;
    return Response.json({ error: friendlyMessage(e.code) }, { status });
  }
  console.error("upload route unexpected error:", e);
  return Response.json({ error: "服务器内部错误" }, { status: 500 });
}

function friendlyMessage(code: string): string {
  switch (code) {
    case "bad_upload_id": return "无效的上传标识";
    case "bad_user_id": return "用户身份无效";
    case "bad_chunk_index":
    case "chunk_out_of_range": return "分片序号越界";
    case "bad_total_chunks": return "分片总数无效";
    case "unsupported_type": return "不支持的文件类型或内容";
    case "bad_category": return "无效的上传分类";
    case "size_too_large": return "文件大小超过限制";
    case "path_escape": return "路径非法";
    case "chunks_incomplete": return "分片不完整";
    case "not_owner": return "无权访问该上传";
    case "manifest_missing": return "上传未开始或已过期";
    case "manifest_corrupt": return "上传记录已损坏";
    case "quota_exceeded": return "存储配额不足";
    case "too_many_concurrent": return "并发上传过多，请稍后再试";
    default: return "上传失败";
  }
}

/**
 * Read the request body with a TRUE streaming hard cap. Do not trust
 * Content-Length: an attacker can omit it or lie. Aborts mid-stream once the
 * cap is exceeded so a malicious body cannot exhaust memory.
 */
async function readBodyCapped(req: Request, maxBytes: number): Promise<Buffer> {
  if (!req.body) {
    throw new UploadPolicyError("size_too_large", "empty body");
  }
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new UploadPolicyError("size_too_large", "body exceeds size limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function saveManifest(chunkDir: string, manifest: UploadManifest): Promise<void> {
  const tmp = buildContainedPath(chunkDir, MANIFEST_FILENAME + ".tmp");
  const final = buildContainedPath(chunkDir, MANIFEST_FILENAME);
  await writeFile(tmp, serializeManifest(manifest), { mode: 0o600 });
  await rename(tmp, final);
}

async function loadManifest(chunkDir: string): Promise<UploadManifest> {
  const p = buildContainedPath(chunkDir, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await readFile(p, "utf8");
  } catch {
    throw new UploadPolicyError("manifest_missing", "manifest not found");
  }
  return parseManifest(raw);
}

/** Reject symlinks and non-regular files before reading a chunk. */
async function assertRegularFile(p: string): Promise<void> {
  let st;
  try {
    st = await lstat(p);
  } catch {
    throw new UploadPolicyError("manifest_corrupt", "expected chunk missing");
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new UploadPolicyError("manifest_corrupt", "chunk is not a regular file");
  }
}

/**
 * Delete ONLY the files this upload owns — the chunk indices declared in the
 * manifest plus the manifest itself — then try a non-recursive rmdir. NEVER
 * recursively delete the chunk directory: that was the data-loss primitive in
 * the old route (rm of a user-derived path).
 */
async function cleanupUpload(chunkDir: string, manifest: UploadManifest): Promise<void> {
  const names = [...expectedChunkNames(manifest.totalChunks), MANIFEST_FILENAME];
  await Promise.all(
    names.map(async (name) => {
      const p = buildContainedPath(chunkDir, name);
      try {
        const st = await lstat(p);
        if (st.isSymbolicLink() || !st.isFile()) return;
        await unlink(p);
      } catch {
        /* missing is fine */
      }
    }),
  );
  try {
    await rmdir(chunkDir);
  } catch {
    /* not empty or already gone — leave for the TTL cleaner */
  }
}

/** Verify an assembled image actually decodes to an allowed raster format. */
async function validateImageContent(partPath: string): Promise<void> {
  let meta;
  try {
    meta = await sharp(partPath).metadata();
  } catch {
    throw new UploadPolicyError("unsupported_type", "image failed to decode");
  }
  const allowed = new Set(["jpeg", "png", "gif", "webp", "avif", "heif"]);
  if (!meta.format || !allowed.has(meta.format)) {
    throw new UploadPolicyError("unsupported_type", "unsupported image content");
  }
}

/** Verify an assembled file is a real, probeable video stream. */
async function validateVideoContent(partPath: string): Promise<void> {
  try {
    await execFileAsync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", partPath],
      { timeout: 20_000 },
    );
  } catch {
    throw new UploadPolicyError("unsupported_type", "video failed to probe");
  }
}

// GET /api/upload?uploadId=xxx — which chunks exist (for resume). Owner-scoped.
export async function GET(req: Request) {
  let userId: string;
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "请先登录" }, { status: 401 });
    }
    userId = sanitizeUserId(session.user.id);
    const uploadId = parseUploadId(new URL(req.url).searchParams.get("uploadId"));
    const chunkDir = buildContainedPath(CHUNK_ROOT, userId, uploadId);
    if (!existsSync(chunkDir)) return Response.json({ chunks: [] });
    let manifest: UploadManifest;
    try {
      manifest = await loadManifest(chunkDir);
    } catch {
      // No manifest yet (queried before first chunk landed) — nothing to resume.
      return Response.json({ chunks: [] });
    }
    assertManifestOwner(manifest, userId); // defense-in-depth; path is already owner-scoped
    const entries = await readdir(chunkDir, { withFileTypes: true });
    const present = entries
      .filter((e) => e.isFile() && /^\d+$/.test(e.name))
      .map((e) => parseInt(e.name, 10))
      .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < manifest.totalChunks);
    return Response.json({ chunks: Array.from(new Set(present)).sort((a, b) => a - b) });
  } catch (e) {
    return policyResponse(e);
  }
}

export async function POST(req: Request) {
  let userId: string;
  let heldUpload = false;
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "请先登录" }, { status: 401 });
    }
    userId = sanitizeUserId(session.user.id);

    const isComplete = req.headers.get("X-Upload-Complete") === "true";
    const uploadIdHeader = req.headers.get("X-Upload-Id");

    if (isComplete && uploadIdHeader) {
      return await completeRelease(userId, req);
    }
    if (!uploadIdHeader) {
      // Single-shot FormData upload (small files ≤ chunk size). No chunk
      // manifest — policy still validates type/size/category and content.
      return await handleSingleUpload(req);
    }

    // ── Chunk upload ─────────────────────────────────────────────────────
    // Opportunistic, rate-limited reclaim of abandoned chunked uploads.
    maybeSweepUploadTemp(CHUNK_ROOT);
    const uploadId = parseUploadId(uploadIdHeader);
    const totalChunks = parseTotalChunks(req.headers.get("X-Total-Chunks"));
    const chunkIndex = parseChunkIndex(req.headers.get("X-Chunk-Index"), totalChunks);

    const chunkDir = buildContainedPath(CHUNK_ROOT, userId, uploadId);
    await mkdir(chunkDir, { recursive: true });

    // First chunk creates the authoritative, immutable manifest. The type,
    // category, totalChunks and totalBytes recorded here cannot be re-trusted
    // from client headers later (complete reads them only from the manifest).
    if (chunkIndex === 0 || !existsSync(buildContainedPath(chunkDir, MANIFEST_FILENAME))) {
      const { kind, mime } = classifyFileType(req.headers.get("X-File-Type"));
      const category = parseCategory(req.headers.get("X-Category"));
      const totalBytes = Number(req.headers.get("X-Total-Bytes") ?? "");
      assertUploadSize(kind, totalBytes);
      await saveManifest(chunkDir, {
        ownerId: userId,
        uploadId,
        kind,
        mime,
        category,
        subDir: categoryToSubdir(category, kind),
        totalChunks,
        totalBytes,
        createdAt: new Date().toISOString(),
      });
    }

    const manifest = await loadManifest(chunkDir);
    assertManifestOwner(manifest, userId);
    if (manifest.totalChunks !== totalChunks) {
      throw new UploadPolicyError("bad_total_chunks", "totalChunks changed mid-upload");
    }
    // Re-validate the index against the manifest's authoritative total.
    const idx = parseChunkIndex(chunkIndex, manifest.totalChunks);

    acquireUpload(userId);
    heldUpload = true;
    try {
      const body = await readBodyCapped(req, MAX_CHUNK_BYTES);
      const chunkPath = buildContainedPath(chunkDir, String(idx));
      // Atomic write: stage then rename, so a partial write never becomes a
      // "complete"-able chunk.
      const staging = chunkPath + ".part";
      await writeFile(staging, body, { mode: 0o600 });
      await rename(staging, chunkPath);
    } finally {
      releaseUpload(userId);
      heldUpload = false;
    }

    return Response.json({ ok: true, chunkIndex: idx, totalChunks: manifest.totalChunks });
  } catch (e) {
    if (heldUpload) releaseUpload(userId!);
    return policyResponse(e);
  }
}

/** Assemble + validate + finalize a completed upload. Manifest is authoritative. */
async function completeRelease(userId: string, req: Request): Promise<Response> {
  const uploadId = parseUploadId(req.headers.get("X-Upload-Id"));
  const chunkDir = buildContainedPath(CHUNK_ROOT, userId, uploadId);
  const manifest = await loadManifest(chunkDir);
  assertManifestOwner(manifest, userId);

  // Read chunk indices present on disk; ignore anything outside the manifest.
  const entries = await readdir(chunkDir, { withFileTypes: true });
  const present = entries
    .filter((e) => e.isFile() && /^\d+$/.test(e.name))
    .map((e) => parseInt(e.name, 10))
    .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < manifest.totalChunks);
  const { complete, missing } = verifyContiguousChunks(present, manifest.totalChunks);
  if (!complete) {
    return Response.json({ error: "分片不完整", missing }, { status: 400 });
  }

  // Sum real chunk sizes (lstat, reject symlinks) and enforce the final cap.
  let total = 0;
  for (const idx of expectedChunkNames(manifest.totalChunks).map(Number)) {
    const cp = buildContainedPath(chunkDir, String(idx));
    await assertRegularFile(cp);
    total += (await stat(cp)).size;
  }
  assertUploadSize(manifest.kind, total);

  // Final destination: server-generated uuid name, fixed extension.
  const uploadDir = buildContainedPath(UPLOADS_ROOT, manifest.subDir);
  await mkdir(uploadDir, { recursive: true });
  let filename = `${crypto.randomUUID()}.${deriveExtension(manifest.mime)}`;
  let finalPath = path.join(uploadDir, filename);
  const partPath = finalPath + ".part";

  // Assemble to a .part, then validate content, then atomic rename. A failure
  // at any step leaves no partial file at the public final path.
  try {
    const writeStream = createWriteStream(partPath);
    for (const idx of expectedChunkNames(manifest.totalChunks).map(Number)) {
      const chunkPath = buildContainedPath(chunkDir, String(idx));
      await assertRegularFile(chunkPath);
      await pipeline(createReadStream(chunkPath), writeStream, { end: false });
    }
    writeStream.end();
    await new Promise<void>((resolve, reject) => {
      writeStream.on("finish", () => resolve());
      writeStream.on("error", reject);
    });

    if (manifest.kind === "image") {
      await validateImageContent(partPath);
      // W1-5: HEIC/AVIF pass the MIME whitelist but nothing downstream can
      // read them (RAG PIL has no heif codec; /api/qa and the rag service
      // only forward jpg/png/gif/webp paths). Transcode once at ingest —
      // every stored image then is a raster the whole pipeline can open.
      const fmt = ((await sharp(partPath).metadata()).format ?? "") as string;
      if (fmt === "heif" || fmt === "avif") {
        // iPhone HEIC: sharp's bundled libheif has no HEVC decoder (patents),
        // but this image already ships ffmpeg — decode with ffmpeg, then
        // re-encode with sharp so EXIF orientation (.rotate) and JPEG
        // quality stay under our control. The intermediate must end in .jpg — ffmpeg
        // picks its encoder from the output extension (.raw emits rawvideo).
        const raw = partPath + ".raw.jpg";
        const norm = partPath + ".norm";
        // .rotate() honors EXIF orientation — iPhone photos land upright.
        await new Promise<void>((resolve, reject) => {
          execFile(
            "ffmpeg",
            ["-y", "-i", partPath, "-frames:v", "1", "-q:v", "2", raw],
            { timeout: 30_000 },
            (err) => (err ? reject(err) : resolve()),
          );
        });
        await sharp(raw).rotate().jpeg({ quality: 92 }).toFile(norm);
        await rm(partPath, { force: true });
        await rm(raw, { force: true });
        await rename(norm, partPath);
        filename = filename.replace(/\.[^.]+$/, ".jpg");
        finalPath = path.join(uploadDir, filename);
      }
    } else {
      await validateVideoContent(partPath);
    }

    await rename(partPath, finalPath);
  } catch (e) {
    await rm(partPath, { force: true }).catch(() => {});
    if (e instanceof UploadPolicyError) throw e;
    throw new UploadPolicyError("unsupported_type", "assembly failed");
  }

  // Post-processing (existing features), failures non-fatal to the upload.
  if (manifest.kind === "image" && manifest.subDir !== "avatars") {
    await applyImageWatermark(finalPath).catch((err) => {
      console.warn("Image watermark skipped:", err.message);
    });
  }
  if (manifest.kind === "video") {
    await withFfmpeg(() =>
      compressVideo(finalPath, manifest.subDir !== "avatars").catch((err) => {
        console.warn("Video compression skipped:", err.message);
      }),
    );
    await withFfmpeg(() =>
      extractVideoThumbnail(filename, finalPath).catch((err) => {
        console.warn("Thumbnail extraction skipped:", err.message);
      }),
    );
  }

  // Cleanup ONLY this upload's known chunk files + manifest (never recursive rm
  // of a derived path).
  await cleanupUpload(chunkDir, manifest).catch((err) => {
    console.warn("Chunk cleanup skipped:", err.message);
  });

  return Response.json({
    url: `/uploads/${manifest.subDir}/${filename}`,
    type: manifest.kind === "video" ? "video" : "image",
  });
}

// Legacy single-shot upload (small images/videos ≤ chunk size). Same hardening:
// policy-validated type/size/category, bounded read, content check, atomic write.
async function handleSingleUpload(req: Request): Promise<Response> {
  // Reject an oversized body before the runtime buffers the FormData.
  const declared = Number(req.headers.get("Content-Length") ?? "0");
  if (declared > maxBytesForKind("video")) {
    return Response.json({ error: "文件大小超过限制" }, { status: 413 });
  }
  const formData = await req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "请选择文件" }, { status: 400 });
  }
  const { kind, mime } = classifyFileType(file.type);
  if (file.size > maxBytesForKind(kind)) {
    return Response.json({ error: "文件大小超过限制" }, { status: 400 });
  }
  const category = parseCategory(formData.get("category"));
  const subDir = categoryToSubdir(category, kind);

  const uploadDir = buildContainedPath(UPLOADS_ROOT, subDir);
  await mkdir(uploadDir, { recursive: true });
  let filename = `${crypto.randomUUID()}.${deriveExtension(mime)}`;
  let finalPath = path.join(uploadDir, filename);
  const partPath = finalPath + ".part";

  try {
    const nodeStream = Readable.fromWeb(file.stream() as import("stream/web").ReadableStream);
    const writeStream = createWriteStream(partPath);
    await pipeline(nodeStream, writeStream);

    if (kind === "image") {
      await validateImageContent(partPath);
      // W1-5: same HEIC/AVIF → JPEG ingest normalization as the chunked path.
      const fmt = ((await sharp(partPath).metadata()).format ?? "") as string;
      if (fmt === "heif" || fmt === "avif") {
        // iPhone HEIC: sharp's bundled libheif has no HEVC decoder (patents),
        // but this image already ships ffmpeg — decode with ffmpeg, then
        // re-encode with sharp so EXIF orientation (.rotate) and JPEG
        // quality stay under our control. The intermediate must end in .jpg — ffmpeg
        // picks its encoder from the output extension (.raw emits rawvideo).
        const raw = partPath + ".raw.jpg";
        const norm = partPath + ".norm";
        await new Promise<void>((resolve, reject) => {
          execFile(
            "ffmpeg",
            ["-y", "-i", partPath, "-frames:v", "1", "-q:v", "2", raw],
            { timeout: 30_000 },
            (err) => (err ? reject(err) : resolve()),
          );
        });
        await sharp(raw).rotate().jpeg({ quality: 92 }).toFile(norm);
        await rm(partPath, { force: true });
        await rm(raw, { force: true });
        await rename(norm, partPath);
        filename = filename.replace(/\.[^.]+$/, ".jpg");
        finalPath = path.join(uploadDir, filename);
      }
    } else {
      await validateVideoContent(partPath);
    }
    await rename(partPath, finalPath);
  } catch (e) {
    await rm(partPath, { force: true }).catch(() => {});
    if (e instanceof UploadPolicyError) throw e;
    throw new UploadPolicyError("unsupported_type", "single-shot upload failed");
  }

  if (kind === "image" && subDir !== "avatars") {
    await applyImageWatermark(finalPath).catch((err) => {
      console.warn("Image watermark skipped:", err.message);
    });
  }
  if (kind === "video" && subDir !== "avatars") {
    await withFfmpeg(() => compressVideo(finalPath, true).catch((err) => {
      console.warn("Video compression skipped:", err.message);
    }));
    await withFfmpeg(() => extractVideoThumbnail(filename, finalPath).catch(() => {}));
  }

  return Response.json({ url: `/uploads/${subDir}/${filename}`, type: kind === "video" ? "video" : "image" });
}

/** Extract first frame of a video as a 360x360 JPEG thumbnail (stored alongside video) */
async function extractVideoThumbnail(filename: string, filepath: string): Promise<void> {
  const videoId = filename.replace(".mp4", "").replace(".webm", "").replace(".mov", "");
  const thumbPath = path.join(path.dirname(filepath), `${videoId}.jpg`);
  await execFileAsync("ffmpeg", [
    "-y", "-i", filepath,
    "-vframes", "1", "-q:v", "2",
    "-vf", "scale=360:360:force_original_aspect_ratio=decrease,pad=360:360:(ow-iw)/2:(oh-ih)/2:color=black",
    thumbPath,
  ], { timeout: 15_000 });
}

/** Compress video with ffmpeg: H.264, CRF 32, max 720p. When addWatermark is
 *  true (and the overlay PNG exists), burn a centered watermark in the SAME
 *  pass via filter_complex — no second transcode. */
async function compressVideo(filepath: string, addWatermark = true): Promise<void> {
  const tmpPath = filepath + ".tmp.mp4";
  // Unwatermarked twin: same basename under videos-raw/ — the admin → 小红书
  // download source. 存量 restored from pre-watermark backup; new uploads write
  // it here too (double-store). Front-end still serves the watermarked file.
  const rawPath = path.join(
    process.cwd(),
    "public",
    "uploads",
    "videos-raw",
    path.basename(filepath),
  );
  try {
    await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0",
      filepath,
    ]);
  } catch {
    return;
  }

  const wmPath = path.join(process.cwd(), "public", "watermark-overlay.png");
  const useWm = addWatermark && existsSync(wmPath);
  const scaleVf = "scale=min(720\\,iw):min(720\\,ih):force_original_aspect_ratio=decrease";

  // videos-raw is a mounted volume; mkdir is cheap & idempotent
  await mkdir(path.dirname(rawPath), { recursive: true }).catch(() => {});

  try {
    // Pass 1: compress UNWATERMARKED → videos-raw (admin download source)
    await execFileAsync("ffmpeg", [
      "-i", filepath,
      "-vf", scaleVf,
      "-c:v", "libx264", "-crf", "32", "-preset", "fast",
      "-c:a", "aac", "-b:a", "64k",
      "-movflags", "+faststart",
      "-y", rawPath,
    ], { timeout: 120_000 });

    if (useWm) {
      // Pass 2: compress + watermark → videos (public front-end version)
      await execFileAsync("ffmpeg", [
        "-i", filepath, "-i", wmPath,
        "-filter_complex",
        `[0:v]${scaleVf}[base];[base][1:v]scale2ref=w=main_w:h=main_h[b2][wm];[b2][wm]overlay=0:0[v]`,
        "-map", "[v]", "-map", "0:a?",
        "-c:v", "libx264", "-crf", "32", "-preset", "fast",
        "-c:a", "aac", "-b:a", "64k",
        "-movflags", "+faststart",
        "-y", tmpPath,
      ], { timeout: 120_000 });
      // watermarked version always replaces (the goal is the watermark)
      const newSize = (await stat(tmpPath).catch(() => ({ size: 0 }))).size;
      if (newSize > 0) {
        await rm(filepath);
        await rename(tmpPath, filepath);
      } else {
        await rm(tmpPath).catch(() => {});
      }
    } else {
      // no watermark: public file = unwatermarked (same as raw)
      await rm(filepath);
      await copyFile(rawPath, filepath);
    }
  } catch {
    await rm(tmpPath).catch(() => {});
    // raw may be partial on failure — leave it; download API falls back to the
    // (possibly original/uncompressed) watermarked filepath if raw is missing.
  }
}
