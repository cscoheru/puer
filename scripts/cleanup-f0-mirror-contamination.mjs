#!/usr/bin/env node

/**
 * cleanup-f0-mirror-contamination.mjs — 一次性清理 F0 单向流动违规。
 *
 * 背景（PRD v0.3 F0）：「AI 文章不得成为 Tasting 数据、站长线、社区带的来源」。
 * 站内存在「跟进帖 → 品鉴笔记」的镜像机制（source='article'），历史上它不区分
 * 内容来源，导致两类违规：
 *
 *   1. AI 内容（auto-post / rag-post / tea-drafts 改写）被镜像进数据层
 *   2. 合成账号（机器人）发的假跟进帖被镜像进数据层 —— 这些不是任何人的
 *      一手品鉴记录，是机器伪造的互动
 *
 * 本脚本按**同一条新口径**清理：只有「origin=human 且作者非合成账号」的帖子
 * 才允许存在镜像。
 *
 * 安全保证：
 *  - 默认 dry-run；--apply 才写库。
 *  - 只删 source='article' 的镜像笔记，绝不碰 evernote/manual/import 原始笔记。
 *  - 删完按茶品重算 tastingNoteCount / avgRating（不是自减，避免漂移）。
 *  - 幂等：重复跑没有可删项时是 no-op。
 *
 * Run:
 *   node --import tsx scripts/cleanup-f0-mirror-contamination.mjs
 *   node --import tsx scripts/cleanup-f0-mirror-contamination.mjs --apply
 */

import { PrismaClient } from "../src/generated/prisma/client.js";

const APPLY = process.argv.includes("--apply");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: missing DATABASE_URL");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    // 全部镜像笔记 + 其源帖 + 作者身份。
    const mirrors = await prisma.tastingNote.findMany({
      where: { source: "article" },
      select: {
        id: true,
        teaId: true,
        sourceId: true,
        authorId: true,
        title: true,
      },
    });
    log(`镜像笔记总数 ${mirrors.length}`);

    const articleIds = [...new Set(mirrors.map((m) => m.sourceId).filter(Boolean))];
    const articles = await prisma.article.findMany({
      where: { id: { in: articleIds } },
      select: { id: true, origin: true, authorId: true, title: true },
    });
    const artById = new Map(articles.map((a) => [a.id, a]));

    const authorIds = [...new Set(mirrors.map((m) => m.authorId))];
    const users = await prisma.user.findMany({
      where: { id: { in: authorIds } },
      select: { id: true, isSynthetic: true, username: true },
    });
    const synthById = new Map(users.map((u) => [u.id, u.isSynthetic]));

    // 判定：源帖必须存在、origin 必须是 human、作者必须不是合成账号。
    const violations = [];
    for (const m of mirrors) {
      const art = m.sourceId ? artById.get(m.sourceId) : undefined;
      let reason = null;
      if (!art) reason = "源帖已不存在";
      else if (art.origin !== "human") reason = `源帖 origin=${art.origin ?? "NULL"}`;
      else if (synthById.get(art.authorId)) reason = "源帖作者是合成账号";
      if (reason) violations.push({ note: m, reason, art });
    }

    log(`违规镜像 ${violations.length} 条（允许存在的 ${mirrors.length - violations.length} 条）`);
    for (const v of violations) {
      log(`  ${v.note.id} tea=${v.note.teaId} 源帖=${v.note.sourceId} 原因=${v.reason}`);
      log(`      标题：${String(v.note.title).slice(0, 40)}`);
    }

    const teaIds = [...new Set(violations.map((v) => v.note.teaId).filter(Boolean))];
    log(`涉及茶品 ${teaIds.length} 款，清理后需重算其 tastingNoteCount / avgRating`);

    if (!APPLY) {
      log("dry-run 结束（加 --apply 写库）");
      return;
    }

    if (violations.length > 0) {
      const ids = violations.map((v) => v.note.id);
      const del = await prisma.tastingNote.deleteMany({ where: { id: { in: ids } } });
      log(`已删除 ${del.count} 条违规镜像笔记`);
    }

    // 重算受影响茶品的统计（按实际条数重算，不是自减 —— 消除历史漂移）。
    for (const teaId of teaIds) {
      const notes = await prisma.tastingNote.findMany({
        where: { teaId },
        select: { appearance: true, color: true, aroma: true, taste: true, aftertaste: true },
      });
      const all = [];
      for (const n of notes) {
        for (const v of [n.appearance, n.color, n.aroma, n.taste, n.aftertaste]) {
          if (typeof v === "number") all.push(v);
        }
      }
      const avg = all.length > 0 ? all.reduce((a, b) => a + b, 0) / all.length : null;
      await prisma.tea.update({
        where: { id: teaId },
        data: { tastingNoteCount: notes.length, avgRating: avg },
      });
    }
    log(`已重算 ${teaIds.length} 款茶品的统计`);

    const left = await prisma.tastingNote.count({ where: { source: "article" } });
    log(`清理后镜像笔记剩余 ${left} 条`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
