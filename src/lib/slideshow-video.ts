import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { mkdir, copyFile, writeFile, rm, access, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const execFileAsync = promisify(execFile);

const PER_IMAGE_SEC = 3;
const MIN_IMAGES = 4;
const MAX_IMAGES = 8;

/**
 * Generate a slideshow video from images (reuses scripts/auto-post.mjs
 * generateVideo logic, async + parameterized). Each image shows PER_IMAGE_SEC
 * seconds, hard-cut, 720x720 black-padded square, H.264 crf30. Cover = first
 * frame as a 360x360 jpg.
 *
 * Input URLs are /uploads/... paths resolved under public/. Images are already
 * watermarked by the upload route, so the video inherits the watermark — no
 * extra burn needed here.
 *
 * Returns {videoUrl, thumbUrl} or null (<MIN images available, or ffmpeg
 * failed). Never throws — callers should still persist the note without video.
 */
export async function generateSlideshowVideo(
  imageUrls: string[]
): Promise<{ videoUrl: string; thumbUrl: string } | null> {
  try {
    // Resolve URLs → disk paths, keep only existing files (cap MAX_IMAGES)
    const available: string[] = [];
    for (const url of imageUrls) {
      if (available.length >= MAX_IMAGES) break;
      const abs = path.join(process.cwd(), "public", url);
      try {
        await access(abs);
        available.push(abs);
      } catch {
        /* skip missing */
      }
    }
    if (available.length < MIN_IMAGES) return null;

    // Unique temp dir per call (avoid concurrent-request collision)
    const tmpDir = await mkdtemp(path.join(tmpdir(), "slideshow-"));

    try {
      // Copy images with sequential names (preserve ext for concat demuxer)
      const files: string[] = [];
      for (let i = 0; i < available.length; i++) {
        const ext = path.extname(available[i]) || ".jpg";
        const dest = path.join(tmpDir, `img${String(i).padStart(3, "0")}${ext}`);
        await copyFile(available[i], dest);
        files.push(dest);
      }

      // concat.txt: each file + duration; repeat last entry (ffmpeg quirk)
      let concat = "";
      for (const f of files) {
        concat += `file '${f}'\nduration ${PER_IMAGE_SEC}\n`;
      }
      concat += `file '${files[files.length - 1]}'\n`;
      const concatPath = path.join(tmpDir, "concat.txt");
      await writeFile(concatPath, concat);

      // Output paths
      const videoId = randomUUID();
      const videoDir = path.join(process.cwd(), "public", "uploads", "videos");
      await mkdir(videoDir, { recursive: true });
      const outputPath = path.join(videoDir, `${videoId}.mp4`);
      const thumbPath = path.join(videoDir, `${videoId}.jpg`);
      const duration = files.length * PER_IMAGE_SEC;

      // Compose slideshow: concat → 720x720 black-padded square
      await execFileAsync(
        "ffmpeg",
        [
          "-y", "-f", "concat", "-safe", "0", "-i", concatPath,
          "-vf", "scale=720:720:force_original_aspect_ratio=decrease,pad=720:720:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p",
          "-c:v", "libx264", "-preset", "fast", "-crf", "30", "-r", "20",
          "-t", String(duration),
          "-movflags", "+faststart",
          outputPath,
        ],
        { timeout: 60_000 }
      );

      // First-frame thumbnail (360x360); failure non-fatal
      let thumbUrl = "";
      try {
        await execFileAsync(
          "ffmpeg",
          [
            "-y", "-i", outputPath,
            "-vframes", "1", "-q:v", "2",
            "-vf", "scale=360:360:force_original_aspect_ratio=decrease,pad=360:360:(ow-iw)/2:(oh-ih)/2:color=black",
            thumbPath,
          ],
          { timeout: 15_000 }
        );
        thumbUrl = `/uploads/videos/${videoId}.jpg`;
      } catch {
        /* thumbnail optional */
      }

      return { videoUrl: `/uploads/videos/${videoId}.mp4`, thumbUrl };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    return null;
  }
}
