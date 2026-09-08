#!/usr/bin/env node
// XHS (小红书) vertical video generator — DEMO of the video template.
// Input: an image (or could be a video frame) + a hook title.
// Output: 9:16 (1080x1920) vertical video, image filling the frame (cropped),
// hook title as subtitle (top), puer.im watermark (bottom).
//
// Usage: node scripts/xhs-video.mjs <image> "<title>" [output.mp4]
import sharp from "sharp";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Render the hook title to a PNG (white bold text + black stroke for legibility,
// auto line-wrap ~14 chars/line). SVG so no font-on-server issues at render time.
async function generateTitlePng(title, outPath) {
  const chars = [...title];
  const PER_LINE = 14;
  const lines = [];
  for (let i = 0; i < chars.length; i += PER_LINE) lines.push(chars.slice(i, i + PER_LINE).join(""));
  const lineHeight = 80;
  const h = lines.length * lineHeight + 40;
  const tspans = lines
    .map((l, i) => `<text x="540" y="${60 + i * lineHeight}" text-anchor="middle" font-family="PingFang SC, Heiti SC, Arial, sans-serif" font-size="60" font-weight="bold" fill="white" stroke="black" stroke-width="4" paint-order="stroke" stroke-linejoin="round">${l.replace(/</g, "&lt;")}</text>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${h}" viewBox="0 0 1080 ${h}">${tspans}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

async function generateXhsVideo(imagePath, title, outputPath) {
  const titlePng = path.join(__dirname, ".xhs-title-tmp.png");
  await generateTitlePng(title, titlePng);
  const wmPath = path.join(__dirname, "..", "public", "watermark-overlay.png");

  await execFileAsync(
    "ffmpeg",
    [
      "-loop", "1", "-i", imagePath,
      "-i", titlePng,
      "-i", wmPath,
      "-filter_complex",
      // image fills 9:16 (crop overflow) + slow zoom (Ken Burns) for life
      "[0:v]scale=1188:2112:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(zoom+0.0008,1.1)':d=200:s=1080x1920:fps=25,setsar=1[bg];" +
        "[1:v]scale=1000:-1[title];" +
        "[2:v]scale=320:-1[wm];" +
        "[bg][title]overlay=(W-w)/2:120[t];" +
        "[t][wm]overlay=(W-w)/2:H-h-120[v]",
      "-map", "[v]",
      "-t", "8",
      "-c:v", "libx264", "-preset", "fast", "-crf", "28", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-y", outputPath,
    ],
    { timeout: 90_000 }
  );
}

const [image, title, out] = process.argv.slice(2);
if (!image || !title) {
  console.error("Usage: node scripts/xhs-video.mjs <image> \"<title>\" [output]");
  process.exit(1);
}
generateXhsVideo(image, title, out || "/tmp/xhs-demo.mp4")
  .then(() => console.log("✓ XHS video:", out || "/tmp/xhs-demo.mp4"))
  .catch((e) => { console.error("FAIL:", e.message.split("\n").slice(-3).join(" ")); process.exit(1); });
