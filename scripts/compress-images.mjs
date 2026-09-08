#!/usr/bin/env node

/**
 * compress-images.mjs — Batch compress all user-uploaded images via sharp
 *
 * Walks uploads/forum/, uploads/inventory/, uploads/evernote/
 * Compresses JPEG/PNG to 1200px max width, quality 75%.
 * Replaces files in-place (backup with --backup flag).
 *
 * Usage:
 *   node scripts/compress-images.mjs [--backup] [--dry-run]
 */

import { readdir, stat, rename, copyFile } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { createInterface } from "node:readline";

const UPLOAD_DIRS = [
  "/app/public/uploads/forum",
  "/app/public/uploads/inventory",
];

const MAX_WIDTH = 1200;
const QUALITY = 75;
const EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

const args = process.argv.slice(2);
const BACKUP = args.includes("--backup");
const DRY_RUN = args.includes("--dry-run");

let totalSaved = 0;
let totalProcessed = 0;
let totalSkipped = 0;

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

async function compressFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (!EXTENSIONS.has(ext)) return null;

  const origSize = (await stat(filePath)).size;
  // Skip files under 100KB (not worth compressing)
  if (origSize < 100 * 1024) return null;

  let compressed;
  try {
    const sharp = (await import("sharp")).default;
    const img = sharp(filePath);
    const meta = await img.metadata();

    if (meta.width && meta.width <= MAX_WIDTH && origSize < 300 * 1024) {
      return null; // Already small enough
    }

    const resized = img.resize({ width: Math.min(meta.width || MAX_WIDTH, MAX_WIDTH), withoutEnlargement: true });
    const outputType = ext === ".png" ? "png" : "jpeg";
    const opts = outputType === "png" ? { compressionLevel: 8 } : { quality: QUALITY, mozjpeg: true };

    if (DRY_RUN) {
      const buf = await resized[outputType](opts).toBuffer();
      compressed = buf;
    } else {
      const tmpPath = filePath + ".tmpcompress";
      await resized[outputType](opts).toFile(tmpPath);
      const tmpSize = (await stat(tmpPath)).size;

      if (tmpSize < origSize) {
        if (BACKUP) {
          const bakPath = filePath + ".bak";
          await copyFile(filePath, bakPath);
        }
        await rename(tmpPath, filePath);
        compressed = { size: tmpSize };
      } else {
        // Compression didn't help, remove temp
        await (await import("node:fs/promises")).unlink(tmpPath);
        return null;
      }
    }
  } catch (err) {
    if (err && typeof err.message === "string" && (err.message.includes("read-only") || err.message.includes("Read-only"))) {
      return null; // Skip read-only files
    }
    console.error(`  ✗ Error: ${filePath} — ${String(err.message || err).slice(0, 80)}`);
    return null;
  }

  const newSize = compressed ? (compressed.size || compressed.length) : origSize;
  const saved = origSize - newSize;
  totalSaved += saved;
  totalProcessed++;
  return { origSize, newSize, saved };
}

function formatBytes(b) {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / (1024 * 1024)).toFixed(1)}MB`;
}

async function main() {
  const sharp = await import("sharp");

  console.log(`=== Image Compression ===`);
  console.log(`Max width: ${MAX_WIDTH}px, Quality: ${QUALITY}%`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE"}`);
  if (BACKUP) console.log(`Backup: .bak files will be created`);
  console.log("");

  for (const dir of UPLOAD_DIRS) {
    if (!existsSync(dir)) {
      console.log(`  [SKIP] ${dir} — not found`);
      continue;
    }
    console.log(`\n  Scanning: ${dir}`);

    let count = 0;
    for await (const filePath of walk(dir)) {
      const ext = extname(filePath).toLowerCase();
      if (!EXTENSIONS.has(ext)) continue;

      const result = await compressFile(filePath);
      if (result) {
        const rel = relative(dir, filePath);
        console.log(`  ${result.saved > 0 ? "✓" : "−"} ${rel}  ${formatBytes(result.origSize)} → ${formatBytes(result.newSize)} (save ${formatBytes(result.saved)})`);
        count++;
      } else {
        totalSkipped++;
      }
    }
    console.log(`  ${count} files processed in ${dir}`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Processed: ${totalProcessed}`);
  console.log(`Skipped: ${totalSkipped}`);
  console.log(`Total saved: ${formatBytes(totalSaved)}`);
  console.log(`Reduction: ${totalProcessed > 0 ? ((totalSaved / (totalSaved + 1)) * 100).toFixed(1) : 0}%`);
}

main().catch(console.error);
