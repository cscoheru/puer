#!/usr/bin/env node

/**
 * mark-synthetic-users.mjs — 把合成账号标记为 isSynthetic=true（一次性）。
 *
 * 圈定依据（2026-10-21 审计，按 email 域名）：
 *   uidN@puer.local  189 个 — auto-register 每天 3–5 个注册
 *   @puer.tea         51 个 — 2026-05 一次性种子
 *   @mock.local       18 个 — 同期 mock 种子
 *   puer-news@puer.local  1 — 全自动资讯署名账号
 * 其余（gmail/example/3strategy 等真人邮箱）不动，未来注册默认 false。
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
    const n = await prisma.user.count({
      where: syntheticWhere(false),
    });
    const already = await prisma.user.count({
      where: syntheticWhere(true),
    });
    const range = await prisma.user.aggregate({
      where: syntheticWhere(),
      _min: { createdAt: true },
      _max: { createdAt: true },
    });
    log(`待标记 ${n} 个（已标记 ${already} 个），注册时间跨度 ${range._min.createdAt?.toISOString().slice(0, 10)} ~ ${range._max.createdAt?.toISOString().slice(0, 10)}`);
    if (n > 0) {
      const sample = await prisma.user.findMany({
        where: syntheticWhere(false),
        select: { uid: true, username: true, email: true },
        orderBy: { createdAt: "asc" },
        take: 5,
      });
      for (const r of sample) log(`  样例 uid=${r.uid} ${r.username} ${r.email}`);
    }

    if (!APPLY) {
      log("dry-run 结束（加 --apply 写库）");
      return;
    }

    const r = await prisma.user.updateMany({
      where: syntheticWhere(false),
      data: { isSynthetic: true },
    });
    log(`已标记 ${r.count} 个账号 isSynthetic=true`);

    // 安全网：域名清单可能漏圈。剩下未标记且不属于已知真人域的账号列出来人工看。
    const missed = await prisma.user.findMany({
      where: {
        isSynthetic: false,
        AND: [
          { email: { not: { endsWith: "@gmail.com" } } },
          { email: { not: { endsWith: "@example.com" } } },
          { email: { not: { endsWith: "@3strategy.cc" } } },
        ],
      },
      select: { uid: true, username: true, email: true },
      take: 20,
    });
    if (missed.length > 0) {
      log(`WARN: 还有 ${missed.length} 个未匹配已知真人域的账号，请人工确认：`);
      for (const r2 of missed) log(`  uid=${r2.uid} ${r2.username} ${r2.email}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * 圈定规则的 email 条件（与审计 §5 同源维护；改这里必须同步审计文档）。
 * 全部以 OR 组合；role 排除由调用方放在 AND 层（放这里会退化成 OR 分支，
 * 使全库非 admin 用户都被命中——2026-10-21 曾因此误标，已回滚）。
 */
function syntheticEmailWhere() {
  return [
    // auto-register 批量号：uidN@puer.local（N 为数字；startsWith+endsWith 组合
    // 等价于 ^uid.*@puer.local$——puer.local 域下只有这批号与 puer-news）
    { AND: [{ email: { startsWith: "uid" } }, { email: { endsWith: "@puer.local" } }] },
    { email: { endsWith: "@puer.tea" } }, // 一次性种子（admin 两个号由此被排除）
    { email: { endsWith: "@mock.local" } }, // mock 种子
    { email: { equals: "puer-news@puer.local" } }, // 全自动资讯署名
  ];
}

/**
 * 完整圈定（与审计 §5 同源维护；改这里必须同步审计文档）：
 * email 命中 + 非 admin（uid 1002/1003 是站长/管理号，站长线数据源）。
 * role 排除必须在 AND 层——放进 OR 数组会退化成独立分支，使全库非 admin
 * 用户都被命中（2026-10-21 曾因此误标站长，已回滚）。
 *
 * @param {boolean} [marked] 传 true/false 时叠加 isSynthetic 过滤（已标记/待标记）。
 */
function syntheticWhere(marked) {
  const cond = {
    AND: [{ OR: syntheticEmailWhere() }, { role: { not: "admin" } }],
  };
  if (marked === undefined) return cond;
  return { AND: [cond, { isSynthetic: marked }] };
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
