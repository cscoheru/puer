import sharp from "sharp";
import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { mkdir, mkdtemp, rm, access } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const execFileAsync = promisify(execFile);

const WM_PATH = path.join(process.cwd(), "public", "watermark-overlay.png");

/**
 * Render hook title → PNG (white bold text + black stroke for legibility,
 * auto line-wrap ~14 chars/line). SVG → sharp so no font-on-server issues at
 * render time (the browser never needs the font installed).
 */
async function generateTitlePng(title: string, outPath: string): Promise<void> {
  const chars = [...title];
  const PER_LINE = 14;
  const lineHeight = 80;
  const lines: string[] = [];
  for (let i = 0; i < chars.length; i += PER_LINE) {
    lines.push(chars.slice(i, i + PER_LINE).join(""));
  }
  const h = lines.length * lineHeight + 40;
  const tspans = lines
    .map(
      (l, i) =>
        `<text x="540" y="${60 + i * lineHeight}" text-anchor="middle" font-family="PingFang SC, Heiti SC, Arial, sans-serif" font-size="60" font-weight="bold" fill="white" stroke="black" stroke-width="4" paint-order="stroke" stroke-linejoin="round">${l.replace(/</g, "&lt;")}</text>`
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${h}" viewBox="0 0 1080 ${h}">${tspans}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

/**
 * Generate a 9:16 (1080×1920) vertical video for 小红书:
 * image fills frame (crop overflow) + slow Ken Burns zoom + hook title subtitle
 * (top) + puer.im watermark (bottom). Output to /uploads/videos/xhs-{uuid}.mp4.
 *
 * Reuses the validated filter from scripts/xhs-video.mjs. mkdtemp per call so
 * concurrent requests don't collide on the title PNG (the demo's hardcoded
 * `.xhs-title-tmp.png` was a concurrency hazard if two admins click at once).
 *
 * @param imageUrl /uploads/... path (resolved under public/)
 * @param title    hook title for the subtitle overlay
 * @returns videoUrl string (/uploads/videos/xhs-{uuid}.mp4)
 * @throws if image missing, or sharp/ffmpeg fail (caller surfaces 500)
 */
export async function generateXhsVideo(
  imageUrl: string,
  title: string
): Promise<string> {
  const imagePath = path.join(process.cwd(), "public", imageUrl);
  await access(imagePath); // throws if source image missing

  const videoId = randomUUID();
  const videoDir = path.join(process.cwd(), "public", "uploads", "videos");
  await mkdir(videoDir, { recursive: true });
  const outputPath = path.join(videoDir, `xhs-${videoId}.mp4`);

  // Unique temp dir per call (avoid concurrent-request collision on title PNG)
  const tmpDir = await mkdtemp(path.join(tmpdir(), "xhs-"));
  try {
    const titlePng = path.join(tmpDir, "title.png");
    await generateTitlePng(title, titlePng);

    await execFileAsync(
      "ffmpeg",
      [
        "-loop", "1", "-i", imagePath,
        "-i", titlePng,
        "-i", WM_PATH,
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

    return `/uploads/videos/xhs-${videoId}.mp4`;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
