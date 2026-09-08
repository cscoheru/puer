#!/usr/bin/env node
/**
 * regenerate-videos.mjs — Regenerate missing slideshow videos
 *
 * For each article with a videoUrl pointing to a non-existent file,
 * pick images from a tasting note and generate a new slideshow video.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DB_URL = process.env.DATABASE_URL;
const VIDEO_DIR = "/app/public/uploads/videos";
const EVERNOTE_DIR = "/app/public/uploads/evernote";
const TMP_DIR = "/tmp/regen-video";

async function sql(query) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const result = await client.query(query);
    return result.rows;
  } finally {
    await client.end();
  }
}

function generateVideo(images, outputPath) {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });

  // Copy images to temp dir
  for (let i = 0; i < images.length; i++) {
    const imgPath = images[i].replace("/uploads/evernote/", `${EVERNOTE_DIR}/`);
    const ext = imgPath.split(".").pop() || "jpg";
    execSync(`cp "${imgPath}" "${TMP_DIR}/img${String(i).padStart(3, "0")}.${ext}"`);
  }

  const duration = images.length * 3;
  let concatContent = "";
  for (let i = 0; i < images.length; i++) {
    const ext = images[i].split(".").pop() || "jpg";
    concatContent += `file '${TMP_DIR}/img${String(i).padStart(3, "0")}.${ext}'\n`;
    concatContent += `duration 3\n`;
  }
  const lastExt = images[images.length - 1].split(".").pop() || "jpg";
  concatContent += `file '${TMP_DIR}/img${String(images.length - 1).padStart(3, "0")}.${lastExt}'\n`;

  writeFileSync(`${TMP_DIR}/concat.txt`, concatContent);

  execSync(
    `ffmpeg -y -f concat -safe 0 -i ${TMP_DIR}/concat.txt \
    -vf "scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p" \
    -c:v libx264 -preset fast -crf 30 -r 20 \
    -t ${duration} \
    -movflags +faststart \
    ${outputPath} 2>/dev/null`,
    { stdio: "pipe" }
  );

  rmSync(TMP_DIR, { recursive: true });
}

async function main() {
  console.log("=== Video regeneration started ===");

  // Get all articles with missing videos
  const articles = await sql(`
    SELECT id, title, "videoUrl"
    FROM articles
    WHERE "videoUrl" LIKE '/uploads/videos/%'
      AND status = 'published'
  `);

  console.log(`Found ${articles.length} articles with videoUrl`);

  // Filter to only those where file doesn't exist
  const missing = articles.filter(a => {
    const filePath = a.videoUrl.replace("/uploads/videos/", `${VIDEO_DIR}/`);
    return !existsSync(filePath);
  });

  console.log(`${missing.length} videos are missing on disk`);

  if (missing.length === 0) {
    console.log("Nothing to do!");
    return;
  }

  // Get all tasting notes with images
  const notes = await sql(`
    SELECT id, images
    FROM tasting_notes
    WHERE images IS NOT NULL AND jsonb_array_length(images) >= 4
    ORDER BY RANDOM()
  `);

  console.log(`${notes.length} tasting notes available with images`);

  let generated = 0;
  let noteIdx = 0;

  for (const article of missing) {
    // Find a note with images that exist on disk
    let selectedImages = null;
    for (let attempt = 0; attempt < 20 && noteIdx < notes.length; attempt++) {
      const note = notes[noteIdx % notes.length];
      noteIdx++;

      const imgs = note.images;
      if (!Array.isArray(imgs) || imgs.length < 4) continue;

      // Check how many images exist
      const available = imgs.filter(img => {
        const p = img.replace("/uploads/evernote/", `${EVERNOTE_DIR}/`);
        return existsSync(p);
      });

      if (available.length >= 4) {
        // Pick 5-8 random images
        const shuffled = available.sort(() => Math.random() - 0.5);
        selectedImages = shuffled.slice(0, Math.min(8, Math.max(5, Math.floor(Math.random() * 4) + 5)));
        break;
      }
    }

    if (!selectedImages) {
      console.log(`  SKIP: ${article.title} — no images available`);
      continue;
    }

    const filePath = article.videoUrl.replace("/uploads/videos/", `${VIDEO_DIR}/`);
    try {
      generateVideo(selectedImages, filePath);
      generated++;
      console.log(`  [${generated}/${missing.length}] ${article.title}`);
    } catch (err) {
      console.log(`  FAIL: ${article.title} — ${err.message.slice(0, 80)}`);
    }
  }

  console.log(`\n=== Generated ${generated}/${missing.length} videos ===`);
}

main().catch(console.error);
