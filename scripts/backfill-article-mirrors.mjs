#!/usr/bin/env node
/**
 * backfill-article-mirrors.mjs — 补建「跟进帖 → 品鉴笔记」的镜像。
 *
 * ## 为什么需要
 *
 * 2026-10-21 的 F0 改动给 Article 加了 `origin` 标注，并规定
 * **只有 origin === "human" 的内容才能进数据层**（AI 文章永不回流）。
 * 但**人工发帖的路径当时没有写 origin** → 那一段窗口里发布的跟进帖，
 * origin 是 NULL → `isHumanOrigin(null)` 为 false → 镜像流程直接跳过 →
 * 这些帖子**永远没有变成品鉴笔记**，也就永远进不了站长线。
 *
 * 2026-10-24 站长实测撞上：在「2012-陈升福元昌古韵圆茶」下发的跟进帖，
 * 茶品页底部看得见帖子，站长线里没有。
 *
 * 写入侧的洞已经补上（各发布路径现在显式标 `origin: "human"`），
 * 这个脚本负责**补上那一段窗口里已经发出去的帖子**。
 *
 * ## 安全保证
 *
 * - 默认 dry-run，只打印统计与样例；`--apply` 才写库。
 * - 幂等：只补「没有镜像」的帖子，已有镜像的一律不碰。
 * - 只补**人工内容**：origin 必须是 'human'，作者不能是合成账号。
 *   AI 文章（origin = ai_from_notes / ai_autonomous）**一律不碰** ——
 *   F0 的单向流动闸在这里再挡一次。
 * - 裸 pg（不依赖镜像内的 Prisma Client 版本）+ 参数化 SQL。
 * - 不删任何行、不改正文、不改状态。
 *
 * Run:
 *   node --import tsx scripts/backfill-article-mirrors.mjs            # dry-run
 *   node --import tsx scripts/backfill-article-mirrors.mjs --apply
 */
import { randomUUID } from "node:crypto";
import { deriveNoteSummary } from "../src/lib/tasting-note-plan.ts";

const APPLY = process.argv.includes("--apply");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * 要补的帖子：已发布、公开、关联了茶品、人工内容、作者不是合成账号、
 * 且**还没有**镜像笔记。
 */
const CANDIDATES_SQL = `
  SELECT a.id, a.title, a.content, a.summary, a."teaId", a."authorId",
         a."createdAt", a.images, a."videoUrl", u."isSynthetic"
    FROM articles a
    JOIN users u ON u.id = a."authorId"
   WHERE a."teaId" IS NOT NULL
     AND a.origin = 'human'
     AND a.status = 'published'
     AND a.visibility = 'public'
     AND u."isSynthetic" = false
     AND NOT EXISTS (
       SELECT 1 FROM tasting_notes n WHERE n."sourceId" = a.id AND n.source = 'article'
     )
   ORDER BY a."createdAt" DESC
`;

/** 插一条镜像笔记（与 planArticleTastingNote 的字段一一对应）。 */
const INSERT_SQL = `
  INSERT INTO tasting_notes
    (id, title, content, summary, images, "videoUrl", "teaId", "authorId",
     source, "sourceId", "createdAt", "updatedAt")
  VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, 'article', $9, $10, $10)
`;

/** 重算茶品的冗余统计（与 recomputeTeaStats 同一口径：所有非空分的总平均）。 */
const RECOUNT_SQL = `
  UPDATE teas t
     SET "tastingNoteCount" = s.n,
         "avgRating" = s.avg
    FROM (
      SELECT "teaId",
             count(*)::int AS n,
             avg(v) AS avg
        FROM (
          SELECT "teaId", "appearance" AS v FROM tasting_notes WHERE "teaId" = $1
          UNION ALL SELECT "teaId", "color" FROM tasting_notes WHERE "teaId" = $1
          UNION ALL SELECT "teaId", "aroma" FROM tasting_notes WHERE "teaId" = $1
          UNION ALL SELECT "teaId", "taste" FROM tasting_notes WHERE "teaId" = $1
          UNION ALL SELECT "teaId", "aftertaste" FROM tasting_notes WHERE "teaId" = $1
        ) x
       WHERE v IS NOT NULL
       GROUP BY "teaId"
    ) s
   WHERE t.id = s."teaId"
`;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: missing required env DATABASE_URL.");
    process.exit(1);
  }
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const { rows } = await client.query(CANDIDATES_SQL);
    log(`mode=${APPLY ? "apply" : "dry-run"} 待补镜像的帖子：${rows.length}`);

    const byTea = new Map();
    let created = 0;
    let skipped = 0;

    for (const a of rows) {
      const summary = a.summary ?? deriveNoteSummary(a.content ?? "");
      if (!APPLY) {
        log(`  dry ${a.title} (tea=${a.teaId})`);
        skipped++;
        continue;
      }
      try {
        await client.query(INSERT_SQL, [
          randomUUID(),
          String(a.title ?? "").slice(0, 200),
          a.content ?? "",
          summary,
          JSON.stringify(Array.isArray(a.images) ? a.images : []),
          a.videoUrl ?? null,
          a.teaId,
          a.authorId,
          a.id,
          a.createdAt,
        ]);
        created++;
        byTea.set(a.teaId, true);
        log(`  created ${a.title} (tea=${a.teaId})`);
      } catch (e) {
        skipped++;
        log(`  FAIL ${a.id}: ${String(e?.message || e).split("\n")[0]}`);
      }
    }

    // 重算受影响茶品的统计（只在真的写入过时才动）。
    if (APPLY && byTea.size > 0) {
      for (const teaId of byTea.keys()) {
        await client.query(RECOUNT_SQL, [teaId]);
      }
      log(`重算统计的茶品：${byTea.size}`);
    }

    log(
      `status=ok candidates=${rows.length} created=${created} skipped=${skipped}`,
    );
    log("=== Done: status=ok ===");
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
