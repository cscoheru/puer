#!/usr/bin/env node

/**
 * backfill-article-origin.mjs — F0 一次性回填 Article.origin。
 *
 * 规则全部来自 src/lib/content-origin.ts 的纯函数（单一真源，本脚本不另写
 * 判定逻辑）：
 *   id 前缀 news-draft_*               → ai_autonomous
 *   id 前缀 tasting-draft_* / aiOriginal /
 *   正文 <!--auto-post--> / <!--rag-post--> 标记 → ai_from_notes
 *   其余                                → human
 *
 * 安全保证：
 *  - 默认 dry-run，只打印分类统计与样例；--apply 才写库。
 *  - 幂等：只更新 origin IS NULL 的行，已分类的一律不碰（绝不覆盖人工修正）。
 *  - originNoteIds 只对能从 auto-post 标记里解出 noteId 的行回填；解不出的
 *    留空数组（不猜、不关联）。
 *  - 不动正文、不改状态、不删任何行。
 *
 * Run:
 *   node --import tsx scripts/backfill-article-origin.mjs            # dry-run
 *   node --import tsx scripts/backfill-article-origin.mjs --apply
 */

import { PrismaClient } from "../src/generated/prisma/client.js";
import {
  classifyOrigin,
  ORIGIN_HUMAN,
  ORIGIN_AI_FROM_NOTES,
  ORIGIN_AI_AUTONOMOUS,
} from "../src/lib/content-origin.ts";

const APPLY = process.argv.includes("--apply");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// <!--auto-post:{noteId}--> 里的 noteId 是 TastingNote.id（cuid），只取
// 安全字符，绝不把正文片段当 id。
const AUTOPOST_NOTE_RE = /<!--\s*auto-post:([A-Za-z0-9_-]{4,40})\s*-->/;

function noteIdsFromContent(content) {
  if (typeof content !== "string") return [];
  const m = content.match(AUTOPOST_NOTE_RE);
  return m ? [m[1]] : [];
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: missing DATABASE_URL");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    // 只捞未回填的行。
    const rows = await prisma.article.findMany({
      where: { origin: null },
      select: { id: true, content: true, aiOriginal: true, authorId: true },
    });
    log(`待回填 ${rows.length} 行（origin IS NULL）`);

    // authorId → isSynthetic（分类规则本身不强依赖它，但打印核对要用）。
    const authorIds = [...new Set(rows.map((r) => r.authorId))];
    const users = await prisma.user.findMany({
      where: { id: { in: authorIds } },
      select: { id: true, isSynthetic: true },
    });
    const synth = new Set(users.filter((u) => u.isSynthetic).map((u) => u.id));

    const buckets = {
      [ORIGIN_HUMAN]: [],
      [ORIGIN_AI_FROM_NOTES]: [],
      [ORIGIN_AI_AUTONOMOUS]: [],
    };
    for (const r of rows) {
      const origin = classifyOrigin({
        id: r.id,
        content: r.content,
        hasAiOriginal: r.aiOriginal !== null && r.aiOriginal !== undefined,
        authorIsSynthetic: synth.has(r.authorId),
        status: "published",
      });
      buckets[origin].push(r);
    }

    for (const [origin, list] of Object.entries(buckets)) {
      log(`  ${origin}: ${list.length}`);
    }

    // 样例核对：每类最多 5 条，尤其要看 human 桶里有没有漏网的 AI 帖。
    for (const [origin, list] of Object.entries(buckets)) {
      if (!list.length) continue;
      log(`--- ${origin} 样例 ---`);
      for (const r of list.slice(0, 5)) {
        const title = String(r.content || "").replace(/<[^>]+>/g, "").slice(0, 28);
        log(`    ${r.id.slice(0, 30).padEnd(30)} ${title}`);
      }
    }

    if (!APPLY) {
      log("dry-run 结束（加 --apply 写库）");
      return;
    }

    let written = 0;
    for (const [origin, list] of Object.entries(buckets)) {
      if (!list.length) continue;
      // human / autonomous 不写 noteIds；from_notes 尝试解标记里的 noteId。
      for (const r of list) {
        const noteIds = origin === ORIGIN_AI_FROM_NOTES ? noteIdsFromContent(r.content) : [];
        const res = await prisma.article.updateMany({
          where: { id: r.id, origin: null }, // 再确认一次：不覆盖
          data: { origin, originNoteIds: noteIds },
        });
        written += res.count;
      }
    }
    log(`已回填 ${written} 行（未命中的说明已被其它进程抢先回填）`);

    // 写后核对：不允许再留 NULL。
    const left = await prisma.article.count({ where: { origin: null } });
    log(`回填后 origin IS NULL 剩余 ${left} 行（应为 0）`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
