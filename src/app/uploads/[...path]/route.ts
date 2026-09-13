import { readFile } from "fs/promises";
import path from "path";

/**
 * P2-R26：uploads 静态文件兜底路由。
 *
 * 背景：Next.js standalone 启动时缓存 public 目录清单，运行期新写入的文件
 * （用户上传的图片、cron 生成的轮播视频）不在清单内 → 静态 serve 404，
 * 直到下次容器重启。public 静态命中优先于本路由（旧文件不受影响），
 * 静态 miss 的请求落到这里直接读磁盘，保证新文件立即可访问。
 *
 * 安全：路径白名单字符 + .. 禁止 + 必须落在 public/uploads 下；只读不改。
 */

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const UPLOADS_ROOT = path.join(process.cwd(), "public", "uploads");

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segs } = await params;
  const rel = segs.join("/");
  // 只允许安全文件名字符，禁止目录穿越
  if (!segs.length || !/^[A-Za-z0-9\-_.]+$/.test(segs[segs.length - 1]) || segs.some((s) => s.includes(".."))) {
    return new Response("Not found", { status: 404 });
  }
  const abs = path.join(UPLOADS_ROOT, rel);
  if (!abs.startsWith(UPLOADS_ROOT + path.sep)) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const data = await readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Accept-Ranges": "none",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
