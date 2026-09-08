import sharp from "sharp";
import { readFile, rename } from "fs/promises";
import path from "path";

const WATERMARK_PATH = path.join(process.cwd(), "public", "watermark-overlay.png");
const TEXTURE_SIZE = 1200; // watermark-overlay.png is a 1200x1200 tileable texture

const SUPPORTED_IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const SKIP_EXTS = new Set([".gif", ".svg"]); // keep animation / vector as-is

let _wmBuffer: Promise<Buffer> | null = null;
function getWatermark(): Promise<Buffer> {
  if (!_wmBuffer) _wmBuffer = readFile(WATERMARK_PATH);
  return _wmBuffer;
}

/** Should this file be watermarked? (supported raster ext, not gif/svg) */
export function shouldWatermarkImage(filepath: string): boolean {
  const ext = path.extname(filepath).toLowerCase();
  if (SKIP_EXTS.has(ext)) return false;
  return SUPPORTED_IMG_EXT.has(ext);
}

/**
 * Tile the watermark texture across the WHOLE image (anti-theft: every region
 * carries a watermark, can't be cropped out). Overhang beyond image bounds is
 * auto-clipped by sharp. In-place overwrite (path/filename unchanged → DB URLs
 * stay valid). Returns true if applied, false if skipped. Caller should .catch().
 */
export async function applyImageWatermark(filepath: string): Promise<boolean> {
  if (!shouldWatermarkImage(filepath)) return false;

  const meta = await sharp(filepath).metadata();
  const W = meta.width ?? 0, H = meta.height ?? 0;
  if (W < 200) return false; // too small

  // Stretch texture to exact image size (fit:fill covers whole image).
  // Avoids sharp's "composite input must be ≤ canvas" error on images smaller
  // than the 1200px texture (most evernote images are). Minor stretch on
  // non-square images is acceptable for anti-theft.
  const wm = await sharp(await getWatermark()).resize(W, H, { fit: "fill" }).toBuffer();

  const ext = path.extname(filepath).toLowerCase();
  const tmp = filepath + ".wm.tmp";
  let chain = sharp(filepath).composite([{ input: wm, left: 0, top: 0 }]);
  if (ext === ".png") chain = chain.png();
  else if (ext === ".webp") chain = chain.webp({ quality: 90 });
  else chain = chain.jpeg({ quality: 90, mozjpeg: true });

  await chain.toFile(tmp);
  await rename(tmp, filepath);
  return true;
}
