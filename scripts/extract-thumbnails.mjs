#!/usr/bin/env node
// Extract first frame from all video posts as thumbnails.
// Usage: docker exec puer-hub-app node /app/scripts/extract-thumbnails.mjs
// Run on host: docker exec puer-hub-app node /app/scripts/extract-thumbnails.mjs

import { execSync } from "child_process";

const VIDEO_DIR = "/app/public/uploads/videos";

// Thumbnails are stored alongside videos in the same directory
import { existsSync, readdirSync, statSync } from "fs";

function extractFirstFrame(videoPath, thumbPath) {
  try {
    execSync(
      `ffmpeg -y -i "${videoPath}" -vframes 1 -q:v 2 -vf "scale=360:360:force_original_aspect_ratio=decrease,pad=360:360:(ow-iw)/2:(oh-ih)/2:color=black" "${thumbPath}" 2>/dev/null`,
      { timeout: 10000 }
    );
    return true;
  } catch (e) {
    console.error(`  [FAIL] ${videoPath}: ${e.message.split("\n")[0]}`);
    return false;
  }
}

// Get all videos
const files = readdirSync(VIDEO_DIR).filter((f) => f.endsWith(".mp4"));
console.log(`Found ${files.length} videos in ${VIDEO_DIR}`);

let extracted = 0;
let skipped = 0;
let failed = 0;

for (const file of files) {
  const videoId = file.replace(".mp4", "");
  const videoPath = `${VIDEO_DIR}/${file}`;
  const thumbPath = `${VIDEO_DIR}/${videoId}.jpg`;

  if (existsSync(thumbPath) && statSync(thumbPath).size > 0) {
    skipped++;
    continue;
  }

  const size = statSync(videoPath).size;
  if (size < 1000) {
    console.log(`  [SKIP] ${file} (${size}B, too small)`);
    skipped++;
    continue;
  }

  process.stdout.write(`  Extracting ${file} ... `);
  if (extractFirstFrame(videoPath, thumbPath)) {
    const thumbSize = statSync(thumbPath).size;
    console.log(`OK (${thumbSize}B)`);
    extracted++;
  } else {
    failed++;
  }
}

console.log(`\nDone: ${extracted} extracted, ${skipped} skipped, ${failed} failed`);
