#!/usr/bin/env node
// Batch-watermark EXISTING images & videos. RUN ON THE HOST (not docker exec):
//   - ./uploads/* are bind-mounts (host-writable)
//   - ./evernote_export/images is :ro inside the container but host-writable
//
// Usage:
//   node scripts/watermark-existing.mjs --dry-run   # preview, no writes
//   node scripts/watermark-existing.mjs             # tar backup, then process
//   node scripts/watermark-existing.mjs --skip-backup   # DANGEROUS, no backup
//
// Run with nohup so SSH disconnects don't kill it:
//   nohup node scripts/watermark-existing.mjs > /tmp/watermark.log 2>&1 &
//
// IMPORTANT — one-time tool: run it ONCE to backfill content that predates the
// watermark feature, ideally BEFORE deploying the watermarked upload route.
// After deployment new uploads are auto-watermarked — do NOT re-run or
// already-watermarked new uploads will be double-stamped.
//
// Idempotency: scripts/.watermark-done.json records each processed file's
// post-watermark sha256, persisted INCREMENTALLY (every 50 files) so an
// interrupted run can be resumed without re-stamping.
import { readdir, rename, readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const ROOT = process.cwd();
const IMG_DIRS = ["uploads/forum", "uploads/sessions", "uploads/inventory", "evernote_export/images"];
const VIDEO_DIR = "uploads/videos";
const WM_PATH = join(ROOT, "public/watermark-overlay.png");
const MANIFEST = join(ROOT, "scripts/.watermark-done.json");
const BACKUP_DIR = join(ROOT, "backups");
const IMG_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const SKIP_EXTS = new Set([".gif", ".svg"]);

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SKIP_BACKUP = args.includes("--skip-backup");

const stats = { processed: 0, skipped: 0, failed: 0 };
const failed = [];
const manifest = {};
let _counter = 0;

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

async function hashFile(p) {
  return createHash("sha256").update(await readFile(p)).digest("hex");
}

/** Persist manifest + log progress every 50 files (crash-safe incremental). */
async function checkpoint(label) {
  if (DRY_RUN) return;
  _counter++;
  if (_counter % 50 === 0) {
    await writeFile(MANIFEST, JSON.stringify(manifest));
    console.log(`[progress:${label}] processed=${stats.processed} skipped=${stats.skipped} failed=${stats.failed}`);
  }
}

function backupAll() {
  if (SKIP_BACKUP) { console.log("[!] --skip-backup: NO BACKUP (dangerous)"); return null; }
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tarball = join(BACKUP_DIR, `uploads-pre-watermark-${stamp}.tar.gz`);
  const dirs = ["uploads/forum", "uploads/videos", "uploads/sessions", "uploads/inventory", "evernote_export/images"]
    .filter((d) => existsSync(join(ROOT, d)));
  if (!dirs.length) { console.log("无可备份目录"); return null; }
  console.log(`备份 → ${tarball}`);
  execFileSync("tar", ["czf", tarball, "-C", ROOT, ...dirs]);
  console.log(`备份完成: ${tarball}`);
  return tarball;
}

async function watermarkImage(filePath, wmBuf) {
  const ext = extname(filePath).toLowerCase();
  if (SKIP_EXTS.has(ext)) return "skip-ext";
  if (!IMG_EXTS.has(ext)) return "skip-type";
  const sharp = (await import("sharp")).default;
  const meta = await sharp(filePath).metadata();
  const W = meta.width ?? 0, H = meta.height ?? 0;
  if (W < 200) return "skip-small";
  // Stretch texture to image size (fit:fill) — avoids sharp error on images
  // smaller than the 1200px texture.
  const wm = await sharp(wmBuf).resize(W, H, { fit: "fill" }).toBuffer();
  const tmp = filePath + ".wm.tmp";
  let chain = sharp(filePath).composite([{ input: wm, left: 0, top: 0 }]);
  if (ext === ".png") chain = chain.png();
  else if (ext === ".webp") chain = chain.webp({ quality: 90 });
  else chain = chain.jpeg({ quality: 90, mozjpeg: true });
  if (!DRY_RUN) {
    await chain.toFile(tmp);
    await rename(tmp, filePath);
  }
  return "ok";
}

function watermarkVideo(filePath) {
  const tmp = filePath + ".wm.tmp.mp4";
  execFileSync("ffmpeg", [
    "-i", filePath, "-i", WM_PATH,
    "-filter_complex",
    "[0:v]scale=min(720\\,iw):min(720\\,ih):force_original_aspect_ratio=decrease[base];[base][1:v]scale2ref=w=main_w:h=main_h[b2][wm];[b2][wm]overlay=0:0[v]",
    "-map", "[v]", "-map", "0:a?",
    "-c:v", "libx264", "-crf", "32", "-preset", "fast",
    "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart",
    "-y", tmp,
  ], { timeout: 180000, stdio: "pipe" });
  if (!DRY_RUN) renameSync(tmp, filePath);
  return "ok";
}

async function loadManifest() {
  try { return JSON.parse(await readFile(MANIFEST, "utf8")); }
  catch { return {}; }
}

async function main() {
  if (!existsSync(WM_PATH)) {
    console.error(`水印章不存在: ${WM_PATH}\n先运行: node scripts/generate-watermark.mjs`);
    process.exit(1);
  }
  const startedAt = Date.now();
  console.log(DRY_RUN ? "[DRY-RUN] 不写盘、不写 manifest" : "[LIVE]");
  const wmBuf = await readFile(WM_PATH);
  const tarball = backupAll();
  Object.assign(manifest, await loadManifest());

  for (const dir of IMG_DIRS) {
    const absDir = join(ROOT, dir);
    if (!existsSync(absDir)) continue;
    console.log(`[scan] ${dir}`);
    for await (const p of walk(absDir)) {
      try {
        const before = await hashFile(p);
        if (manifest[p] === before) { stats.skipped++; continue; }
        const r = await watermarkImage(p, wmBuf);
        if (r === "ok") {
          stats.processed++;
          if (!DRY_RUN) manifest[p] = await hashFile(p);
        } else stats.skipped++;
        await checkpoint("img");
      } catch (e) { stats.failed++; failed.push(`${relative(ROOT, p)}: ${e.message.split("\n")[0]}`); }
    }
  }

  const vDir = join(ROOT, VIDEO_DIR);
  if (existsSync(vDir)) {
    console.log(`[scan] ${VIDEO_DIR}`);
    for await (const p of walk(vDir)) {
      if (extname(p).toLowerCase() !== ".mp4") continue;
      try {
        const before = await hashFile(p);
        if (manifest[p] === before) { stats.skipped++; continue; }
        console.log(`[video] ${relative(ROOT, p)}`);
        watermarkVideo(p);
        stats.processed++;
        if (!DRY_RUN) manifest[p] = await hashFile(p);
        await checkpoint("vid");
      } catch (e) { stats.failed++; failed.push(`${relative(ROOT, p)}: ${e.message.split("\n")[0]}`); }
    }
  }

  if (!DRY_RUN) await writeFile(MANIFEST, JSON.stringify(manifest, null, 2));
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n完成 (${elapsed}s): processed=${stats.processed} skipped=${stats.skipped} failed=${stats.failed}`);
  if (tarball) console.log(`备份: ${tarball}  (回滚: tar xzf <tarball> -C ${ROOT})`);
  if (failed.length) { console.log("失败明细:"); failed.forEach((f) => console.log("  " + f)); }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
