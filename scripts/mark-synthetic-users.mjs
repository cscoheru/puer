#!/usr/bin/env node

/**
 * mark-synthetic-users.mjs — 把合成账号标记为 isSynthetic=true（一次性）。
 *
 * 圈定依据：**系统造号的痕迹**，不是邮箱域名。详见下方 SYNTHETIC_PREDICATE
 * 的注释（2026-10-22 修正：按域名圈定曾误标 70 个真人注册账号）。
 *
 * 幂等：重复跑只 UPDATE 已匹配行；--dry-run（默认）只打印统计不写库。
 *
 * Environment:
 *   DATABASE_URL — PostgreSQL 连接（cron-task.sh 同款来源）
 *
 * Run:
 *   node --import tsx scripts/mark-synthetic-users.mjs --dry-run   # 默认
 *   node --import tsx scripts/mark-synthetic-users.mjs --apply
 */

import { PrismaClient } from "../src/generated/prisma/client.js";

const APPLY = process.argv.includes("--apply");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ERROR: missing DATABASE_URL");
    process.exit(1);
  }
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const n = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM users u WHERE (${SYNTHETIC_PREDICATE}) AND u."isSynthetic" = false`,
    );
    const already = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM users u WHERE (${SYNTHETIC_PREDICATE}) AND u."isSynthetic" = true`,
    );
    const range = await prisma.$queryRawUnsafe(
      `SELECT min(u."createdAt")::date AS lo, max(u."createdAt")::date AS hi FROM users u WHERE (${SYNTHETIC_PREDICATE})`,
    );
    const nCount = n[0].n;
    log(
      `待标记 ${nCount} 个（已标记 ${already[0].n} 个），` +
        `注册时间跨度 ${range[0].lo} ~ ${range[0].hi}`,
    );
    if (nCount > 0) {
      const sample = await prisma.$queryRawUnsafe(
        `SELECT u.uid, u.username, u.email FROM users u WHERE (${SYNTHETIC_PREDICATE}) AND u."isSynthetic" = false ORDER BY u."createdAt" ASC LIMIT 5`,
      );
      for (const r of sample) log(`  样例 uid=${r.uid} ${r.username} ${r.email}`);
    }

    if (!APPLY) {
      log("dry-run 结束（加 --apply 写库）");
      return;
    }

    const r = await prisma.$executeRawUnsafe(
      `UPDATE users u SET "isSynthetic" = true, "updatedAt" = NOW()
       WHERE (${SYNTHETIC_PREDICATE}) AND u."isSynthetic" = false`,
    );
    log(`已标记 ${r} 个账号 isSynthetic=true`);

    // 安全网：域名清单可能漏圈。剩下未标记且不属于已知真人域的账号列出来人工看。
    // 安全网：所有**符合真人判据**却还标着合成的账号，都该被人看一眼。
    const missed = await prisma.$queryRawUnsafe(
      `SELECT u.uid, u.username, u.email FROM users u
       WHERE u."isSynthetic" = true
         AND u.email <> 'puer-news@puer.local'
         AND u.role <> 'admin'
         AND (
              (u."registrationIp" IS NOT NULL AND u."registrationIp" <> '')
           OR (u.nickname IS NOT NULL AND u.nickname <> u.username)
           OR (u.email NOT LIKE '%@puer.local' AND u.email NOT LIKE '%@puer.tea' AND u.email NOT LIKE '%@mock.local')
         )
       ORDER BY u.uid LIMIT 20`,
    );
    if (missed.length > 0) {
      log(`WARN: 还有 ${missed.length} 个未匹配已知真人域的账号，请人工确认：`);
      for (const r2 of missed) log(`  uid=${r2.uid} ${r2.username} ${r2.email}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * 合成账号的判定：**不是**按邮箱域名，而是按「系统造号的痕迹」。
 *
 * ## 为什么不能按邮箱域名
 *
 * 注册接口（src/app/api/auth/register/route.ts）**自动生成邮箱**：
 * `email: uid${nextUid}@puer.local`。真人和 auto-register 造出来的机器号
 * 用的是同一个域名格式 —— 2026-10-21 按域名圈定，把 70 个真人注册账号
 * 误标成合成账号（显晟茶居、温广源、半盏浓……），并因此把他们的赞与
 * 评论从展示计数里剔掉了。**域名不是判据。**
 *
 * ## 正确判据（三条并用）
 *
 *  1. 有 registrationIp —— 真人注册接口会写，auto-register 不写
 *  2. nickname ≠ username —— 注册接口会写 nickname（自填昵称才有差异），
 *     auto-register 根本不写该字段
 *  3. 邮箱在种子域里 —— @puer.local / @puer.tea / @mock.local
 *
 * 三条**都不满足**的才是合成账号。admin 与 puer-news 显式排除。
 *
 * ## 为什么这个脚本还存在
 *
 * 它是**一次性**标记工具（首次给存量账号打标）。判据修好后仍需保留：
 * 新装的库里如果预置了账号，它负责把机器号挑出来。
 * 日常的账号增删不需要跑它 —— 新注册用户默认 isSynthetic=false，
 * 而 auto-register 建号时直接写 true（见该脚本的 INSERT）。
 *
 * 改这里必须同步审计文档。
 */
const SEED_DOMAINS = ["@puer.local", "@puer.tea", "@mock.local"];

/** 合成账号判定（SQL 表达式）。nickname ≠ username 是列与列比较，Prisma 的 where 做不了，必须在 SQL 层判。 */
const SYNTHETIC_PREDICATE = `
  u.email <> 'puer-news@puer.local'
  AND u.role <> 'admin'
  AND NOT (
       (u."registrationIp" IS NOT NULL AND u."registrationIp" <> '')
    OR (u.nickname IS NOT NULL AND u.nickname <> u.username)
  )
  AND (
       u.email LIKE '%@puer.local'
    OR u.email LIKE '%@puer.tea'
    OR u.email LIKE '%@mock.local'
  )
`;

/**
 * 判据的 SQL 片段在文件上方（SYNTHETIC_PREDICATE）。
 * 这里不用 Prisma 的 where：nickname ≠ username 是列与列比较，
 * Prisma 表达不了，只能走 $queryRaw。
 */

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
