import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import path from "path";
import {
  PUBLIC_UPLOADS_ROOT,
  RAW_VIDEOS_ROOT,
  isInside,
} from "@/lib/upload-storage";

// GET /api/admin/videos/[articleId]/download — 管理员专用视频下载。
// 流式返回帖子原视频,带 Content-Disposition: attachment 触发浏览器下载。
// requireAdmin 确保下载能力只在管理员手里(注:/uploads/ 文件本身仍公开
// serve,因为前台帖子页要给所有用户播放;本接口保证的是「下载入口」受控)。
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ articleId: string }> }
) {
  const { error } = await requireAdmin();
  if (error) return error;

  const { articleId } = await params;
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { videoUrl: true, title: true },
  });
  if (!article?.videoUrl) {
    return NextResponse.json({ error: "该帖无视频" }, { status: 404 });
  }

  // ?raw=1 → unwatermarked (private/videos-raw/, for 无水印 下载); default →
  // public watermarked file (防盗). The raw twin lives OUTSIDE public/ so it
  // is never reachable by URL — this admin-gated route is the only door.
  // Raw missing falls back to watermarked.
  const wantRaw = new URL(_req.url).searchParams.get("raw") === "1";
  const rawPath = path.join(RAW_VIDEOS_ROOT, path.basename(article.videoUrl));
  // videoUrl is stored verbatim from the post body, so it is NOT a trusted
  // path: resolve it against the uploads root and refuse anything that
  // escapes it. Without this, a crafted videoUrl would let this route read
  // any file in the container — including the private raw tier.
  let filePath = path.join(PUBLIC_UPLOADS_ROOT, path.basename(article.videoUrl));
  if (!isInside(PUBLIC_UPLOADS_ROOT, filePath)) {
    return NextResponse.json({ error: "视频文件不存在" }, { status: 404 });
  }
  if (wantRaw) {
    try {
      await stat(rawPath);
      filePath = rawPath; // unwatermarked version exists → use it
    } catch {
      /* raw missing → stay on watermarked public file */
    }
  }
  try {
    const info = await stat(filePath);
    // 文件名:标题前 30 字 + .mp4,清掉文件系统不友好字符(保留中文)
    const safe = (article.title || "video")
      .slice(0, 30)
      .replace(/[^一-龥a-zA-Z0-9-_]/g, "_");
    const encoded = encodeURIComponent(`${safe}.mp4`);
    // Node stream → Web ReadableStream,流式返回不占内存
    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;

    return new Response(stream, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(info.size),
        // 双写 filename:ASCII fallback + RFC 5987 UTF-8(中文浏览器优先)
        "Content-Disposition": `attachment; filename="video.mp4"; filename*=UTF-8''${encoded}`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "视频文件不存在" }, { status: 404 });
  }
}
