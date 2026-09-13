/**
 * backfill-videos.mjs — 一次性补生成存量帖子的轮播视频（P2-R26）。
 *
 * 背景：2026-09-09 起 auto-post 改在宿主机跑（/opt/puer-hub 无 public/uploads），
 * generateSlideshowVideo 的图片读取/视频写入路径全部落空 → 所有 tasting-draft
 * 帖 videoUrl=null。本脚本在【容器内】跑（cwd=/app，uploads 完整），为
 * images ≥ MIN_IMAGES 且 videoUrl 为空的帖子补生成视频并写回 DB。
 *
 * 用法（容器内，cron-task.sh 同款入口）：
 *   docker exec puer-hub-app ./node_modules/.bin/tsx scripts/backfill-videos.mjs [--limit N]
 *
 * 幂等：videoUrl 已有的跳过；重复跑安全。
 */
import { PrismaClient } from "@prisma/client";
import { generateSlideshowVideo } from "../src/lib/slideshow-video.ts";

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 30 : 30;
const MIN_IMAGES = 4; // mirrors slideshow-video.ts

function makePrisma() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: missing required env DATABASE_URL.");
    process.exit(1);
  }
  return new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const prisma = makePrisma();
  try {
    // String[] 标量列表无 { some: {} } 过滤；取 videoUrl 为空的帖子后在代码侧判断张数
    const rows = await prisma.article.findMany({
      where: { videoUrl: null },
      select: { id: true, title: true, images: true, videoUrl: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    const eligible = rows.filter((r) => (r.images?.length ?? 0) >= MIN_IMAGES).slice(0, LIMIT);
    log(`=== Backfill videos: eligible=${eligible.length}/${rows.length} (limit=${LIMIT}) ===`);

    let ok = 0;
    let fail = 0;
    for (const row of eligible) {
      const result = await generateSlideshowVideo(row.images);
      if (!result) {
        log(`  ✗ ${row.id} “${row.title}” → generation failed (missing files on disk?)`);
        fail++;
        continue;
      }
      const r = await prisma.article.updateMany({ where: { id: row.id, videoUrl: null }, data: { videoUrl: result.videoUrl } });
      if (r.count === 1) {
        log(`  ✓ ${row.id} “${row.title}” → ${result.videoUrl}`);
        ok++;
      } else {
        log(`  • ${row.id} “${row.title}” → already had video; skipped`);
      }
    }
    log(`=== Done: ${ok} generated, ${fail} failed ===`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
