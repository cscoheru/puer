#!/usr/bin/env node

/**
 * cellar-usage-report.mjs — 我的茶仓使用报表（PRD v0.3 §5 Phase 2）。
 *
 * 支撑 Phase 2 的**退出标准**：
 *
 *   「站长与至少 10 位种子用户内测一周，快速品鉴的中位耗时 < 30 秒」
 *
 * 所以这个报表要回答三个问题：
 *   1. 有多少人在用（种子用户够不够 10 位）？
 *   2. 快速品鉴快不快（中位耗时）？
 *   3. 他们在回访吗（回访率 = 记过 ≥2 条的人 / 记过 ≥1 条的人）？
 *
 * ## 口径说明（每条都写清楚，别让数字被误读）
 *
 * - **中位耗时**用中位数不用平均数：一次误操作（挂机半小时）会把平均数
 *   拉长好几倍，而中位数不受影响。退出标准说的是「中位」，口径一致。
 * - **耗时**只统计带 elapsedSeconds 的记录 —— 那是客户端在表单挂载到
 *   保存成功之间量的。没有这个数的记录（比如补录的）不参与。
 * - **回访率**的分母是「记过至少一条」的人。分子是「记过至少两条」的人。
 *   PRD §5 说的成功信号是「自发产生 2 条以上回访品鉴」，用的就是这一个。
 * - 合成账号（isSynthetic）的记录**单独列出来但不计入**——它们不是人。
 *
 * Run:
 *   node --import tsx scripts/cellar-usage-report.mjs
 *   node --import tsx scripts/cellar-usage-report.mjs --days 30
 *   node --import tsx scripts/cellar-usage-report.mjs --json
 */

import { PrismaClient } from "../src/generated/prisma/client.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const DAYS = Number(arg("days", "0"));
const AS_JSON = has("json");
/** 退出标准要求的最小参与人数 */
const SEED_TARGET = Number(arg("seed-target", "10"));
/** 退出标准要求的快速品鉴中位耗时上限（秒） */
const MEDIAN_TARGET = Number(arg("median-target", "30"));

const prisma = new PrismaClient();

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pct(n, total) {
  if (!total) return "—";
  return `${((n / total) * 100).toFixed(0)}%`;
}

async function main() {
  const since = DAYS > 0 ? new Date(Date.now() - DAYS * 86400_000) : null;
  const where = since ? { tastedAt: { gte: since } } : {};

  const [tastings, itemCount, usersTotal, syntheticUsers] = await Promise.all([
    prisma.cellarTasting.findMany({
      where,
      select: {
        elapsedSeconds: true,
        userId: true,
        user: { select: { isSynthetic: true, uid: true, username: true } },
      },
    }),
    prisma.cellarItem.count(),
    prisma.cellarItem.groupBy({ by: ["userId"], _count: { _all: true } }),
    prisma.user.count({ where: { isSynthetic: true } }),
  ]);

  // 合成账号的记录不算「人的记录」，单独剔除。
  const human = tastings.filter((t) => !t.user.isSynthetic);
  const synthetic = tastings.filter((t) => t.user.isSynthetic);

  const elapsed = human
    .map((t) => t.elapsedSeconds)
    .filter((v) => typeof v === "number" && v >= 0);
  const med = median(elapsed);

  const byUser = new Map();
  for (const t of human) {
    byUser.set(t.userId, (byUser.get(t.userId) ?? 0) + 1);
  }
  const activeUsers = byUser.size;
  const returningUsers = [...byUser.values()].filter((n) => n >= 2).length;

  const report = {
    windowDays: DAYS || "全部",
    items: itemCount,
    usersWithItems: usersTotal.length,
    tastings: human.length,
    activeUsers,
    returningUsers,
    returnRate: activeUsers ? returningUsers / activeUsers : null,
    medianElapsedSeconds: med,
    elapsedSamples: elapsed.length,
    syntheticTastings: synthetic.length,
    seedTarget: SEED_TARGET,
    medianTarget: MEDIAN_TARGET,
    meetsExitCriteria:
      activeUsers >= SEED_TARGET && med !== null && med < MEDIAN_TARGET,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("── 我的茶仓使用报表 ──");
  console.log(`统计范围：${report.windowDays === "全部" ? "全部" : `最近 ${report.windowDays} 天`}`);
  console.log("");
  console.log(`茶仓条目：${report.items} 个（${report.usersWithItems} 位用户）`);
  console.log(`品鉴记录：${report.tastings} 条（另有合成账号 ${report.syntheticTastings} 条，不计入）`);
  console.log("");
  console.log(`参与用户：${report.activeUsers} 位（目标 ≥${SEED_TARGET} 位）`);
  console.log(
    `回访率：${returningUsers}/${activeUsers} = ${pct(returningUsers, activeUsers)}` +
      `（记过 ≥2 条的人 / 记过 ≥1 条的人）`,
  );
  console.log("");
  console.log(
    `快速品鉴中位耗时：${med === null ? "无数据" : `${med} 秒`}` +
      `（${elapsed.length} 条带耗时的记录，目标 <${MEDIAN_TARGET} 秒）`,
  );
  if (elapsed.length) {
    const sorted = [...elapsed].sort((a, b) => a - b);
    console.log(`  分布：最快 ${sorted[0]} 秒 / 最慢 ${sorted[sorted.length - 1]} 秒`);
  }
  console.log("");
  console.log(
    report.meetsExitCriteria
      ? "✅ 达到退出标准"
      : "⏳ 尚未达到退出标准（人数与中位耗时都要达标）",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
