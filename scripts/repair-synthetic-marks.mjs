#!/usr/bin/env node

/**
 * repair-synthetic-marks.mjs — 修正 isSynthetic 的误标。
 *
 * ## 事故
 *
 * 2026-10-21 标记合成账号时用的是**邮箱域名**规则（`uidN@puer.local` /
 * `@puer.tea` / `@mock.local`）。但注册接口
 * （src/app/api/auth/register/route.ts）**自动生成邮箱**：
 *
 *     email: `uid${nextUid}@puer.local`
 *
 * 真人和 auto-register 造出来的机器号**用的是同一个域名格式** ——
 * 域名根本区分不了谁是谁。于是 70 个真人注册账号被误标成合成账号
 * （真实注册 IP、自拟昵称、真人风格的评论）。
 *
 * 误标在「剔除展示计数」这个方向是有害的：真人的赞与评论会从展示里被剔掉。
 *
 * ## 正确判据（三条并用）
 *
 *  1. **有 registrationIp** —— 真人注册接口会写（`registrationIp: ip`），
 *     auto-register 与早期种子脚本不写。但 2026-05-24 之前注册的账号
 *     还没有这个字段，所以单靠它不够。
 *  2. **nickname ≠ username** —— 注册接口会写 nickname（用户自填昵称才会
 *     出现差异），auto-register 根本不写 nickname 字段。早期种子脚本写了
 *     nickname 但等于 username，靠「差异」区分。
 *  3. **邮箱不在种子域里** —— 真实个人邮箱（gmail/163/…）。
 *
 * 为什么不能只靠其中一条：
 *   - 只看 registrationIp：漏掉 2026-05-24 之前注册的（接口那时还没这字段）
 *   - 只看 nickname：早期种子脚本也写了 nickname（值等于 username）
 *   - 只看邮箱域：注册接口自动生成 uidN@puer.local，真人机器同格式
 *     —— 这正是误标的根因
 *
 * **两个绝对不能碰的**：
 *   - role=admin（古道茶人、云水禅心）—— 站长自己的账号，邮箱落在种子域里
 *     但没有 registrationIp（早期手工创建），判成机器是最严重的一种错
 *   - puer-news@puer.local（茶社资讯）—— 系统控制的 AI 发布账号，永远是合成账号
 *
 * ## 安全保证
 *
 *  - 默认 dry-run；--apply 才写库。
 *  - 只改 isSynthetic 这一个字段，不动其它任何数据。
 *  - 幂等：反复跑结果一致。
 *
 * Run:
 *   node --import tsx scripts/repair-synthetic-marks.mjs
 *   node --import tsx scripts/repair-synthetic-marks.mjs --apply
 */

import { PrismaClient } from "../src/generated/prisma/client.js";

const APPLY = process.argv.includes("--apply");

/** 明显是压测/测试用途的账号名特征（仅用于报告，不改变判定）。 */
const TEST_NAME_RE = /test|测试|sectest|rltest|pentest|noemail/i;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * 真人判据（SQL 表达式）。Prisma 的 where 做不了「列与列比较」，
 * nickname ≠ username 必须在 SQL 层判。
 */
const REAL_PREDICATE = `
      (u."registrationIp" IS NOT NULL AND u."registrationIp" <> '')
   OR (u.nickname IS NOT NULL AND u.nickname <> u.username)
   OR (u.email NOT LIKE '%@puer.local'
       AND u.email NOT LIKE '%@puer.tea'
       AND u.email NOT LIKE '%@mock.local')
`;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: missing DATABASE_URL");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    // 被误标为合成、但符合真人判据的账号 → 改回真人
    const mislabeled = await prisma.$queryRawUnsafe(`
      SELECT u.id, u.uid, u.username, u.email, u.nickname, u."registrationIp",
             u."createdAt",
             (SELECT count(*) FROM comments c WHERE c."authorId" = u.id) AS comments,
             (SELECT count(*) FROM articles a WHERE a."authorId" = u.id) AS articles
      FROM users u
      WHERE u."isSynthetic" = true
        AND u.email <> 'puer-news@puer.local'
        AND u.role <> 'admin'
        AND (${REAL_PREDICATE})
      ORDER BY u.uid
    `);

    // 标为真人、但不符合真人判据的账号 → 改回机器
    const missed = await prisma.$queryRawUnsafe(`
      SELECT u.id, u.uid, u.username, u.email, u.role
      FROM users u
      WHERE u."isSynthetic" = false
        AND u.email <> 'puer-news@puer.local'
        AND u.role <> 'admin'
        AND NOT (${REAL_PREDICATE})
      ORDER BY u.uid
    `);

    const testish = mislabeled.filter((u) => TEST_NAME_RE.test(u.username));

    log(`误标为合成、但符合真人判据：${mislabeled.length} 个`);
    log(`  其中用户名像压测账号的：${testish.length} 个（${testish.map((u) => u.username).join(", ")}）`);
    for (const u of mislabeled.slice(0, 8)) {
      log(
        `    uid=${u.uid} ${u.username} 昵称=${u.nickname ?? "-"} ip=${u.registrationIp ?? "-"} ` +
          `帖${u.articles} 评${u.comments}`,
      );
    }
    if (mislabeled.length > 8) log(`    …（其余 ${mislabeled.length - 8} 个略）`);

    log(`标为真人、但不符合真人判据：${missed.length} 个`);
    for (const u of missed.slice(0, 8)) {
      log(`    uid=${u.uid} ${u.username} ${u.email} role=${u.role}`);
    }

    if (!APPLY) {
      log("dry-run 结束（加 --apply 写库）");
      return;
    }

    if (mislabeled.length > 0) {
      const r = await prisma.user.updateMany({
        where: { id: { in: mislabeled.map((u) => u.id) } },
        data: { isSynthetic: false },
      });
      log(`已把 ${r.count} 个账号改回真人（isSynthetic=false）`);
    }
    if (missed.length > 0) {
      const r = await prisma.user.updateMany({
        where: { id: { in: missed.map((u) => u.id) } },
        data: { isSynthetic: true },
      });
      log(`已把 ${r.count} 个账号改回机器（isSynthetic=true）`);
    }

    const [real, synth] = await Promise.all([
      prisma.user.count({ where: { isSynthetic: false } }),
      prisma.user.count({ where: { isSynthetic: true } }),
    ]);
    log(`修正后：真人 ${real} · 合成 ${synth}`);
    log("下一步：重跑 scripts/recompute-real-counts.mjs --apply（幂等，会把真人的赞与评论算回来）");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
