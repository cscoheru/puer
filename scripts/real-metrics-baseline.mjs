#!/usr/bin/env node

/**
 * real-metrics-baseline.mjs — 近 90 天**真实用户**指标基线
 * （PRD v0.3 §7 F0「指标重算：Phase 0 内重算近 90 天的 DAU、留存和互动数据，
 * 剔除自动化账号和爬虫流量，作为新的基线」+ §12 决策 4）。
 *
 * 每个指标都并列给出「含自动化」与「只计真人」两个数，差值就是被机器人
 * 撑起来的虚高部分。报告的目标不是好看，是**给出可对照的基线**，供
 * 后续剔除展示计数后验证。
 *
 * 口径说明：
 *  - DAU：当日有**行为**（发帖/评论/投票/点赞）的去重用户数。
 *    只计真人账号（isSynthetic=false）。
 *  - 留存：某日活跃的用户，在 D+1 / D+7 / D+30 是否仍活跃。
 *    口径为「滚动留存」——首日活跃集合在后续每一天的回访比例。
 *  - 互动：发帖/评论/投票/点赞，真人 vs 全部。
 *  - 爬虫流量：article_views 里的记录是 JS 客户端 beacon 发的，爬虫不发；
 *    但**历史** article_views 是空的，爬虫流量只能从 nginx 日志估。
 *    本脚本用日志给出爬虫请求占比作为参考。
 *
 * Run:
 *   node --import tsx scripts/real-metrics-baseline.mjs [--days 90]
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { PrismaClient } from "../src/generated/prisma/client.js";

const DAYS = (() => {
  const i = process.argv.indexOf("--days");
  const n = i >= 0 ? parseInt(process.argv[i + 1], 10) : 90;
  return Number.isInteger(n) && n > 0 ? n : 90;
})();

const LOG_PATH = process.env.READER_BASELINE_LOG || "/var/log/nginx/access.log";

const BOT_RE =
  /bot|spider|crawl|archiver|googlebot|baidu|bingbot|slurp|duckduckbot|yandexbot|semrush|ahrefsbot|facebookexternalhit|twitterbot|linkedinbot|python-requests|curl|wget|headless|lighthouse|siteaudit|dataforseo/i;

function log(msg) {
  console.log(msg);
}

/** 真人账号 id 集合。 */
async function realUserIds(prisma) {
  const users = await prisma.user.findMany({
    where: { isSynthetic: false },
    select: { id: true },
  });
  return new Set(users.map((u) => u.id));
}

/** 某个账号集合在某天是否有行为，返回 Map<日期, Set<用户>>。 */
async function activityByDay(prisma, since, userIds) {
  const [articles, comments, votes, likes] = await Promise.all([
    prisma.article.findMany({
      where: { createdAt: { gte: since }, authorId: { in: [...userIds] } },
      select: { authorId: true, createdAt: true },
    }),
    prisma.comment.findMany({
      where: { createdAt: { gte: since }, authorId: { in: [...userIds] } },
      select: { authorId: true, createdAt: true },
    }),
    prisma.vote.findMany({
      where: { createdAt: { gte: since }, userId: { in: [...userIds] } },
      select: { userId: true, createdAt: true },
    }),
    prisma.like.findMany({
      where: { createdAt: { gte: since }, userId: { in: [...userIds] } },
      select: { userId: true, createdAt: true },
    }),
  ]);

  const byDay = new Map();
  const add = (uid, d) => {
    let set = byDay.get(d);
    if (!set) {
      set = new Set();
      byDay.set(d, set);
    }
    set.add(uid);
  };
  const day = (dt) => dt.toISOString().slice(0, 10);
  for (const r of articles) add(r.authorId, day(r.createdAt));
  for (const r of comments) add(r.authorId, day(r.createdAt));
  for (const r of votes) add(r.userId, day(r.createdAt));
  for (const r of likes) add(r.userId, day(r.createdAt));
  return byDay;
}

function dauStats(byDay) {
  const days = [...byDay.keys()].sort();
  if (!days.length) return { avg: 0, max: 0, days: 0, series: [] };
  const counts = days.map((d) => byDay.get(d).size);
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  return {
    avg: Number(avg.toFixed(1)),
    max: Math.max(...counts),
    days: days.length,
    series: days.map((d, i) => ({ date: d, dau: counts[i] })),
  };
}

/** 滚动留存：首日活跃集合在后续每一天的回访比例。 */
function retention(byDay) {
  const days = [...byDay.keys()].sort();
  if (!days.length) return null;
  const base = byDay.get(days[0]);
  const out = { d1: null, d7: null, d30: null };
  for (const [label, offset] of [["d1", 1], ["d7", 7], ["d30", 30]]) {
    const target = days[offset];
    if (!target) continue;
    const that = byDay.get(target);
    let hit = 0;
    for (const uid of base) if (that.has(uid)) hit++;
    out[label] = Number(((hit / base.size) * 100).toFixed(1));
  }
  return { baseDay: days[0], baseSize: base.size, ...out };
}

/** 爬虫请求占比（从 nginx 日志估）。 */
function botShare() {
  if (!existsSync(LOG_PATH)) return null;
  let total = 0;
  let bots = 0;
  for (const line of readFileSync(LOG_PATH, "utf8").split("\n")) {
    if (!line) continue;
    const m = /"([^"]*)"\s*$/.exec(line);
    if (!m) continue;
    total++;
    if (BOT_RE.test(m[1])) bots++;
  }
  if (!total) return null;
  return {
    total,
    bots,
    pct: Number(((bots / total) * 100).toFixed(1)),
    logMtime: statSync(LOG_PATH).mtime.toISOString().slice(0, 16),
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: missing DATABASE_URL");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const since = new Date(Date.now() - DAYS * 86400_000);
    const realIds = await realUserIds(prisma);

    log("═".repeat(70));
    log(` 真实用户指标基线（近 ${DAYS} 天，PRD v0.3 §7 F0）`);
    log("═".repeat(70));

    // ── 用户结构 ──
    const [totalUsers, syntheticUsers] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isSynthetic: true } }),
    ]);
    log("");
    log("【用户结构】");
    log(`  全部账号 ${totalUsers} · 合成 ${syntheticUsers} · 真人 ${totalUsers - syntheticUsers}`);

    // ── DAU ──
    const realByDay = await activityByDay(prisma, since, realIds);
    const allIds = new Set(
      (
        await prisma.user.findMany({ select: { id: true } })
      ).map((u) => u.id),
    );
    const allByDay = await activityByDay(prisma, since, allIds);
    const dauReal = dauStats(realByDay);
    const dauAll = dauStats(allByDay);

    log("");
    log("【日活跃用户 DAU】（有发帖/评论/投票/点赞行为的去重用户）");
    log(`  只计真人   平均 ${dauReal.avg} · 峰值 ${dauReal.max} · 有数据的天数 ${dauReal.days}`);
    log(`  含自动化   平均 ${dauAll.avg} · 峰值 ${dauAll.max} · 有数据的天数 ${dauAll.days}`);
    if (dauAll.avg > 0) {
      log(`  虚高倍数   ${(dauAll.avg / Math.max(dauReal.avg, 0.1)).toFixed(1)}×`);
    }

    // ── 留存 ──
    const retReal = retention(realByDay);
    const retAll = retention(allByDay);
    log("");
    log("【留存】（首日活跃集合在后续每一天的回访率，滚动口径）");
    if (retReal && retAll) {
      log(`  只计真人   基准日 ${retReal.baseDay}（${retReal.baseSize} 人）  D+1 ${retReal.d1 ?? "—"}%  D+7 ${retReal.d7 ?? "—"}%  D+30 ${retReal.d30 ?? "—"}%`);
      log(`  含自动化   基准日 ${retAll.baseDay}（${retAll.baseSize} 人）  D+1 ${retAll.d1 ?? "—"}%  D+7 ${retAll.d7 ?? "—"}%  D+30 ${retAll.d30 ?? "—"}%`);
    } else {
      log("  数据不足");
    }

    // ── 互动 ──
    // Prisma 的 where 需要字段名：{ createdAt: { gte } }，不能直接传 { gte }。
    const sinceQ = { createdAt: { gte: since } };
    const [aAll, aReal, cAll, cReal, vAll, vReal, lAll, lReal] = await Promise.all([
      prisma.article.count({ where: sinceQ }),
      prisma.article.count({ where: { ...sinceQ, authorId: { in: [...realIds] } } }),
      prisma.comment.count({ where: sinceQ }),
      prisma.comment.count({ where: { ...sinceQ, authorId: { in: [...realIds] } } }),
      prisma.vote.count({ where: sinceQ }),
      prisma.vote.count({ where: { ...sinceQ, userId: { in: [...realIds] } } }),
      prisma.like.count({ where: sinceQ }),
      prisma.like.count({ where: { ...sinceQ, userId: { in: [...realIds] } } }),
    ]);
    const pct = (real, all) => (all > 0 ? `${((real / all) * 100).toFixed(1)}%` : "—");
    log("");
    log("【互动量】");
    log(`  发帖   ${String(aReal).padStart(5)} / ${String(aAll).padStart(5)}   真人占 ${pct(aReal, aAll)}`);
    log(`  评论   ${String(cReal).padStart(5)} / ${String(cAll).padStart(5)}   真人占 ${pct(cReal, cAll)}`);
    log(`  投票   ${String(vReal).padStart(5)} / ${String(vAll).padStart(5)}   真人占 ${pct(vReal, vAll)}`);
    log(`  点赞   ${String(lReal).padStart(5)} / ${String(lAll).padStart(5)}   真人占 ${pct(lReal, lAll)}`);

    // ── 展示计数现状 ──
    const viewAgg = await prisma.article.aggregate({ _sum: { viewCount: true } });
    const upAgg = await prisma.article.aggregate({ _sum: { upvotes: true } });
    const replyAgg = await prisma.article.aggregate({ _sum: { replyCount: true } });
    const realUp = await prisma.vote.count({
      where: { value: 1, userId: { in: [...realIds] } },
    });
    const realReply = await prisma.comment.count({
      where: { authorId: { in: [...realIds] } },
    });
    log("");
    log("【展示计数（重算前）】");
    log(`  articles.upvotes 合计 ${upAgg._sum.upvotes}  →  真人投票 ${realUp}`);
    log(`  articles.replyCount 合计 ${replyAgg._sum.replyCount}  →  真人评论 ${realReply}`);
    log(`  articles.viewCount 合计 ${viewAgg._sum.viewCount}  →  无作者维度，无法拆分（定位是热度）`);

    // ── 爬虫流量 ──
    const bs = botShare();
    log("");
    log("【爬虫流量（nginx 日志估）】");
    if (bs) {
      log(`  日志快照 ${bs.logMtime} UTC · 请求 ${bs.total} · 爬虫 ${bs.bots}（${bs.pct}%）`);
      log("  注：这些请求全部计入了 articles.viewCount，且占了 SSR 渲染的大头。");
    } else {
      log("  日志不可读，跳过");
    }

    log("");
    log("═".repeat(70));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e);
  process.exit(1);
});
