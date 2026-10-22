#!/usr/bin/env node

/**
 * recompute-real-counts.mjs — 把被自动化账号污染的**计数列**重算为只计真人。
 *
 * ## 背景（PRD v0.3 §12 决策 4）
 *
 * 「历史冒用：先锁定池子，再剔除展示计数；剔除展示与指标基线重算一起做，
 * 不晚于 Phase 0 结束。」
 *
 * 站内的展示计数是**冗余列**（articles.upvotes / downvotes / replyCount、
 * boards.postCount / threadCount），由写入路径维护。但机器人脚本
 * （auto-vote / auto-boost-new / boost-essence）是用**裸 SQL 直接写 votes
 * 表并顺手 UPDATE 计数列**的 —— 它们绕过了应用层，所以计数列里同样有
 * 机器人的贡献。实测：投票 23,059 中 22,074 来自合成账号（96%），
 * 评论 2,547 中 2,407 来自合成账号（95%）。
 *
 * 本脚本按「只计真人」重算这些列。它**不删除任何明细**（明细保留用于
 * 审计，PRD 说「历史自动化投票保留记录用于审计」），只纠正展示用的计数。
 *
 * ## viewCount 为什么不重算
 *
 * articles.viewCount 是 SSR 页面**每渲染一次 +1** 的计数器（见
 * forum/thread/[id]/page.tsx），没有作者维度 —— 爬虫的每次渲染都计入了。
 * 它无法按账号拆分，因此本脚本不动它；它的定位是**热度**（热榜公式的
 * 相对值），不是「多少人读过」。前台「阅读」已改用 article_views 的
 * 去重真实读者数。
 *
 * ## 安全保证
 *
 *  - 默认 dry-run，只打印将要改动的量；--apply 才写库。
 *  - 幂等：反复跑结果一致（按实际明细重算，不做自增自减）。
 *  - 只 UPDATE 计数列，不动明细、不动状态、不删行。
 *
 * Run:
 *   node --import tsx scripts/recompute-real-counts.mjs            # dry-run
 *   node --import tsx scripts/recompute-real-counts.mjs --apply
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
    // ── 采集「只计真人」的真实值 ──────────────────────────────────
    // 帖子级投票/评论。
    // 用标量子查询而不是 JOIN：votes 与 comments 同时 LEFT JOIN 会产生
    // 笛卡尔积（一帖 3 票 2 评论 → 6 行），计数直接被放大。
    const voteRows = await prisma.$queryRaw`
      SELECT a.id,
             (SELECT count(*) FROM votes v
               WHERE v."refId" = a.id AND v.value = 1
                 AND v."userId" IN (SELECT id FROM users WHERE "isSynthetic" = false))::int AS up,
             (SELECT count(*) FROM votes v
               WHERE v."refId" = a.id AND v.value = -1
                 AND v."userId" IN (SELECT id FROM users WHERE "isSynthetic" = false))::int AS down,
             (SELECT count(*) FROM comments c
               WHERE c."articleId" = a.id
                 AND c."authorId" IN (SELECT id FROM users WHERE "isSynthetic" = false))::int AS replies
      FROM articles a
    `;

    // 版块级帖子/主题数（只计真人发的帖）
    const boardRows = await prisma.$queryRaw`
      SELECT b.id,
             (SELECT count(*) FROM articles a
               WHERE a."boardId" = b.id
                 AND a."authorId" IN (SELECT id FROM users WHERE "isSynthetic" = false))::int AS posts,
             (SELECT count(*) FROM articles a
               WHERE a."boardId" = b.id AND a.type = 'discussion'
                 AND a."authorId" IN (SELECT id FROM users WHERE "isSynthetic" = false))::int AS threads
      FROM boards b
    `;

    // ── 与现值对比 ────────────────────────────────────────────────
    const articles = await prisma.article.findMany({
      select: { id: true, upvotes: true, downvotes: true, replyCount: true },
    });
    const boards = await prisma.board.findMany({
      select: { id: true, name: true, postCount: true, threadCount: true },
    });

    const articleFixes = [];
    for (const r of voteRows) {
      const cur = articles.find((a) => a.id === r.id);
      if (!cur) continue;
      if (cur.upvotes !== r.up || cur.downvotes !== r.down || cur.replyCount !== r.replies) {
        articleFixes.push({
          id: r.id,
          before: { up: cur.upvotes, down: cur.downvotes, replies: cur.replyCount },
          after: { up: r.up, down: r.down, replies: r.replies },
        });
      }
    }

    const boardFixes = [];
    for (const r of boardRows) {
      const cur = boards.find((b) => b.id === r.id);
      if (!cur) continue;
      if (cur.postCount !== r.posts || cur.threadCount !== r.threads) {
        boardFixes.push({
          id: r.id,
          name: cur.name,
          before: { posts: cur.postCount, threads: cur.threadCount },
          after: { posts: r.posts, threads: r.threads },
        });
      }
    }

    const sum = (fixes, path) =>
      fixes.reduce((a, f) => a + (f.before[path] - f.after[path]), 0);

    log(`待修正的帖子计数：${articleFixes.length} 个`);
    log(`  累计削减 赞 ${sum(articleFixes, "up")} / 踩 ${sum(articleFixes, "down")} / 回复 ${sum(articleFixes, "replies")}`);
    log(`待修正的版块计数：${boardFixes.length} 个`);
    log(`  累计削减 帖子 ${sum(boardFixes, "posts")} / 主题 ${sum(boardFixes, "threads")}`);

    for (const f of articleFixes.slice(0, 5)) {
      log(`  ${f.id.slice(0, 12)} 赞 ${f.before.up}→${f.after.up} 踩 ${f.before.down}→${f.after.down} 回复 ${f.before.replies}→${f.after.replies}`);
    }
    for (const f of boardFixes.slice(0, 3)) {
      log(`  版块 ${f.name} 帖子 ${f.before.posts}→${f.after.posts} 主题 ${f.before.threads}→${f.after.threads}`);
    }

    if (!APPLY) {
      log("dry-run 结束（加 --apply 写库）");
      return;
    }

    // ── 先落一份「改前」快照，回滚时按它还原 ────────────────────
    // 重算是幂等的（按实际明细重算），但「还原成机器人也算的旧值」需要
    // 原始数字 —— 所以写库前先存一份。
    const backupPath = `/opt/puer-hub/backups/real-counts-before-${new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .slice(0, 15)}.json`;
    const backup = {
      at: new Date().toISOString(),
      articles: articleFixes.map((f) => ({ id: f.id, ...f.before })),
      boards: boardFixes.map((f) => ({ id: f.id, ...f.before })),
    };
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(backupPath, JSON.stringify(backup, null, 2));
      log(`改前快照已存：${backupPath}`);
    } catch (e) {
      console.error("无法写入快照，中止（不写库）", e);
      return;
    }

    let fixed = 0;
    for (const f of articleFixes) {
      await prisma.article.update({
        where: { id: f.id },
        data: {
          upvotes: f.after.up,
          downvotes: f.after.down,
          replyCount: f.after.replies,
        },
      });
      fixed++;
    }
    for (const f of boardFixes) {
      await prisma.board.update({
        where: { id: f.id },
        data: { postCount: f.after.posts, threadCount: f.after.threads },
      });
      fixed++;
    }
    log(`已重算 ${fixed} 行的计数列`);

    // 写后核对
    const after = await prisma.article.aggregate({
      _sum: { upvotes: true, downvotes: true, replyCount: true },
    });
    log(`重算后合计 赞 ${after._sum.upvotes} / 踩 ${after._sum.downvotes} / 回复 ${after._sum.replyCount}`);
    log("注：viewCount 未动 —— 它是 SSR 渲染计数（无作者维度），定位是热度而非读者数。");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
