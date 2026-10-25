#!/usr/bin/env node
/**
 * F4 复饮提醒跑批 —— 给到期的茶仓条目发一条站内通知。
 *
 * ## 它做什么
 *
 * 每天扫一次 `cellar_items` 里 `nextRemindAt <= now` 的条目，给它的主人
 * 发一条 `type='reminder'` 的站内通知（链接到那条茶仓条目），并把
 * `nextRemindAt` 往后推一个周期。
 *
 * ## 为什么不是「应用层算好、cron 只发消息」
 *
 * `nextRemindAt` 的口径在 `src/lib/cellar-reminder.ts`（纯函数，可离线单测）：
 *   anchor       = 最近一次品鉴的**服务端 createdAt**（按同一条茶跨条目）
 *                   → acquiredAt → createdAt
 *   nextRemindAt = max( anchor + N 个月 , lastRemindedAt + N 个月 )
 *
 * 跑批发完提醒后，`lastRemindedAt = now` → 下一次就是 `now + N`（周期提醒）。
 *
 * ## 幂等（最重要的一条）
 *
 * 跑批可能重跑（cron 重启、手工再跑一次、两个实例同时跑）。三重保险：
 *   1. 认领用 `FOR UPDATE OF ci SKIP LOCKED` —— 并发跑批各拿各的；
 *   2. 推进 `nextRemindAt` 的 UPDATE **WHERE 必须带完整双守卫**
 *      （`nextRemindAt <= now` AND `lastRemindedAt IS NULL OR < nextRemindAt`）
 *      —— 守卫不全会天天重复提醒，或者提醒一次就永远沉默；
 *   3. 认领 + 推进 + 插通知在**同一个事务**里 —— 插通知失败就整体回滚，
 *      下次跑批重试。**提醒不会被吞掉**（「静默降级 = 延迟爆炸」）。
 *
 * ## Environment
 *
 *   DATABASE_URL    — Postgres 连接串（cron-task.sh 提供）
 *   CELLAR_REMINDERS_PAUSED=1 — 一键暂停（主动停用，退出码 0，不该触发告警）
 *   CELLAR_REMINDERS_MAX_PER_RUN  — 单次最多发多少条（默认 200）
 *   CELLAR_REMINDERS_MAX_PER_USER — 同一用户单次最多收几条（默认 5）
 *   FEATURE_CELLAR / CELLAR_UIDS / EDITOR_AUTHOR_UIDS — 茶仓可见性（cron-task.sh 提供）
 *
 * ## Run
 *
 *   node --import tsx scripts/cellar-reminders.mjs --dry-run   # 默认，只报告
 *   node --import tsx scripts/cellar-reminders.mjs --apply     # 真发
 *
 * 纯 pg（不依赖 Prisma Client）—— 宿主的 node_modules 里 Prisma 版本与镜像
 * 里的可能对不上，而 pg 永远是 pg。
 */
import { randomUUID } from "node:crypto";

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX_PER_RUN = intEnv("CELLAR_REMINDERS_MAX_PER_RUN", 200);
const MAX_PER_USER = intEnv("CELLAR_REMINDERS_MAX_PER_USER", 5);
const BATCH_SIZE = 50;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * 认领到期条目。
 *
 * `FOR UPDATE OF ci SKIP LOCKED`：只锁 cellar_items 这一侧（LEFT JOIN 的
 * 可空侧不能被 FOR UPDATE 锁，Postgres 会直接报错）；SKIP LOCKED 让并发
 * 的跑批各拿各的，不互相等。
 */
const CLAIM_SQL = `
  SELECT ci.id                       AS id,
         ci."userId"                AS user_id,
         u.uid                      AS user_uid,
         ci."teaId"                 AS tea_id,
         COALESCE(t.name, ci.name)  AS tea_name,
         ci."remindEveryMonths"     AS remind_every_months,
         ci."nextRemindAt"          AS next_remind_at,
         ci."lastRemindedAt"        AS last_reminded_at,
         ci."acquiredAt"            AS acquired_at,
         ci."createdAt"             AS created_at
    FROM cellar_items ci
    JOIN users u ON u.id = ci."userId"
    LEFT JOIN teas t ON t.id = ci."teaId"
   WHERE ci."nextRemindAt" IS NOT NULL
     AND ci."nextRemindAt" <= $1
     AND ci."remindEveryMonths" > 0
     AND (ci."lastRemindedAt" IS NULL OR ci."lastRemindedAt" < ci."nextRemindAt")
     AND u."banStatus" = 'active'
     AND u."isSynthetic" = false
     AND ci.id <> ALL($2::text[])
   ORDER BY ci."nextRemindAt" ASC
   LIMIT $3
     FOR UPDATE OF ci SKIP LOCKED
`;

/**
 * 推进 nextRemindAt —— **WHERE 必须带完整双守卫**。
 *
 * 少了 `lastRemindedAt` 那一段：并发跑批会各插一条通知；
 * 少了 `nextRemindAt <= $1`：已经推后的条目会被反复推。
 */
const ADVANCE_SQL = `
  UPDATE cellar_items
     SET "lastRemindedAt" = $1,
         "nextRemindAt"   = $2
   WHERE id = $3
     AND "nextRemindAt" IS NOT NULL
     AND "nextRemindAt" <= $1
     AND ("lastRemindedAt" IS NULL OR "lastRemindedAt" < "nextRemindAt")
  RETURNING id
`;

/**
 * 插通知 —— **id / read / createdAt 必须显式给全**。
 *
 * notifications 表是别处建的：id 是 text NOT NULL 且**数据库层没有默认值**
 * （默认值在 Prisma 客户端侧），裸 INSERT 漏了 id 会直接 NOT NULL 报错。
 */
const INSERT_NOTIFICATION_SQL = `
  INSERT INTO notifications (id, "userId", type, content, link, read, "createdAt")
  VALUES ($1, $2, 'reminder', $3, $4, false, $5)
`;

/**
 * 同一条茶最近一次品鉴的对照与阶段（按茶跨条目）。
 *
 * ⚠️ **必须带 userId 过滤** —— 茶品库是全站共享的，A 用户和 B 用户可以
 * 有同一个 teaId 的条目。不按 userId 过滤就会拿到**别人**的私有品鉴记录，
 * 通知文案会基于别人的记录生成（既是隐私泄露，也是错误的建议）。
 * 这与 src/lib/cellar-data.ts 的口径一致（那里 where 里带 userId）。
 */
const LAST_TASTING_BY_TEA_SQL = `
  SELECT DISTINCT ON (x."teaId", x."userId") x."teaId" AS tea_id,
         x."userId" AS user_id,
         t."deltaVsPrev" AS delta_vs_prev, t.stage AS stage, t."createdAt" AS created_at
    FROM cellar_tastings t
    JOIN cellar_items x ON x.id = t."cellarItemId"
   WHERE x."teaId" = ANY($1::text[])
     AND t."userId" = x."userId"
   ORDER BY x."teaId", x."userId", t."createdAt" DESC
`;

/** 自建茶（没有 teaId）最近一次品鉴。 */
const LAST_TASTING_BY_ITEM_SQL = `
  SELECT DISTINCT ON (t."cellarItemId") t."cellarItemId" AS cellar_item_id,
         t."deltaVsPrev" AS delta_vs_prev, t.stage AS stage, t."createdAt" AS created_at
    FROM cellar_tastings t
    JOIN cellar_items x ON x.id = t."cellarItemId"
   WHERE t."cellarItemId" = ANY($1::text[])
     AND t."userId" = x."userId"
   ORDER BY t."cellarItemId", t."createdAt" DESC
`;

async function main() {
  // 暂停开关要在**任何 import / 连库之前**判定：
  // 主动停用不是故障，退出码 0，不该触发 cron 的 ALERT 告警。
  if (process.env.CELLAR_REMINDERS_PAUSED === "1") {
    log("cellar-reminders 已暂停（CELLAR_REMINDERS_PAUSED=1），不发任何提醒。");
    process.exit(0);
  }

  const DB_URL = process.env.DATABASE_URL;
  if (!DB_URL) {
    console.error("ERROR: missing required env DATABASE_URL.");
    process.exit(1);
  }

  const { Client } = await import("pg");
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  try {
    // 纯逻辑（TypeScript）—— 宿主上由 tsx 加载（cron-task.sh 用
    // `node --import tsx`）。可见性用现成的纯函数，**不要在这里重写一遍
    // 白名单**（src/lib/cellar-guard.ts 的文件头专门警告过这件事）。
    const {
      computeNextRemindAt,
      monthsSince,
      reminderAdvice,
      reminderNotificationText,
    } = await import("../src/lib/cellar-reminder.ts");
    const { cellarVisibleTo } = await import("../src/lib/cellar-guard.ts");

    const now = new Date();
    const nowIso = now.toISOString();

    const stats = {
      processed: 0,
      sent: 0,
      skippedInvisible: 0,
      skippedUserCap: 0,
      skippedAlreadyHandled: 0,
      errors: 0,
    };
    /** 因「跳过」被排除的条目 —— 下一批不再挑它们（否则死循环）。 */
    const excluded = [];
    /** 本次已发条数（同一用户的上限）。 */
    const perUser = new Map();
    const details = [];

    for (;;) {
      await client.query("BEGIN");
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      try {
        const { rows } = await client.query(CLAIM_SQL, [
          nowIso,
          excluded,
          BATCH_SIZE,
        ]);
        if (rows.length === 0) {
          await client.query("COMMIT");
          break;
        }
        stats.processed += rows.length;

        // 最近一次品鉴（按茶 **+ 按人**）—— 用来算锚点、建议与文案。
        const teaIds = [...new Set(rows.map((r) => r.tea_id).filter(Boolean))];
        const itemIds = rows.map((r) => r.id);
        const byTea = new Map();
        const byItem = new Map();
        if (teaIds.length) {
          const t = await client.query(LAST_TASTING_BY_TEA_SQL, [teaIds]);
          for (const row of t.rows) byTea.set(`${row.tea_id}:${row.user_id}`, row);
        }
        const i = await client.query(LAST_TASTING_BY_ITEM_SQL, [itemIds]);
        for (const row of i.rows) byItem.set(row.cellar_item_id, row);

        for (const row of rows) {
          const teaName = row.tea_name || "你的茶";
          const link = `/tea-cellar/${row.id}`;

          // 可见性：看不见茶仓的人不该收到提醒（链接点进去是 404）。
          if (!cellarVisibleTo({ uid: row.user_uid }, process.env)) {
            stats.skippedInvisible++;
            excluded.push(row.id);
            details.push(`skip(invisible) ${teaName} uid=${row.user_uid}`);
            continue;
          }

          // 单用户上限：别让一个条目多的人被刷屏。
          const used = perUser.get(row.user_id) ?? 0;
          if (used >= MAX_PER_USER) {
            stats.skippedUserCap++;
            excluded.push(row.id);
            details.push(`skip(user-cap) ${teaName} uid=${row.user_uid}`);
            continue;
          }

          const last = row.tea_id
            ? byTea.get(`${row.tea_id}:${row.user_id}`)
            : byItem.get(row.id);
          const advice = reminderAdvice(
            { deltaVsPrev: last?.delta_vs_prev ?? null, stage: last?.stage ?? null },
            row.remind_every_months,
          );
          // 「已经 N 个月没复饮」要用**实际**经过的月数，不是提醒间隔。
          const anchor = last?.created_at
            ? new Date(last.created_at)
            : row.acquired_at
              ? new Date(row.acquired_at)
              : new Date(row.created_at);
          const content = reminderNotificationText({
            teaName,
            monthsSinceLast: monthsSince(anchor, now),
            months: row.remind_every_months,
            advice,
          });

          // 下次提醒的时刻 —— **调唯一实现**（src/lib/cellar-reminder.ts），
          // 不要在这里自己算：两份口径必然漂（AGENTS.md 的「数据双轨」）。
          const next = computeNextRemindAt({
            remindEveryMonths: row.remind_every_months,
            anchor,
            lastRemindedAt: row.last_reminded_at,
            now,
          });

          if (DRY_RUN) {
            // dry-run **一个字都不写** —— 连 nextRemindAt 都不能推进。
            details.push(
              `dry ${teaName} uid=${row.user_uid} → 下次 ${next ? next.toISOString().slice(0, 10) : "-"}`,
            );
            perUser.set(row.user_id, used + 1);
            continue;
          }

          // 推进 nextRemindAt（守卫在 WHERE 里）。
          const advanced = await client.query(ADVANCE_SQL, [
            nowIso,
            next ? next.toISOString() : null,
            row.id,
          ]);
          if (advanced.rowCount === 0) {
            // 别人刚处理过这条 —— 跳过，不重复提醒。
            stats.skippedAlreadyHandled++;
            excluded.push(row.id);
            continue;
          }

          await client.query(INSERT_NOTIFICATION_SQL, [
            randomUUID(),
            row.user_id,
            content,
            link,
            nowIso,
          ]);
          stats.sent++;
          perUser.set(row.user_id, used + 1);
          details.push(`sent ${teaName} uid=${row.user_uid}`);
        }

        await client.query("COMMIT");
      } catch (err) {
        // 整批回滚：推进与通知都没发生 → 下次跑批重试，提醒不会丢。
        await client.query("ROLLBACK").catch(() => {});
        stats.errors++;
        log(`batch failed: ${String(err?.message || err).split("\n")[0]}`);
        throw err;
      }

      // 上限按**真发出去的条数**算 —— 被跳过的条目不消耗预算，
      // 否则「一堆看不见茶仓的到期条目」会把跑批卡成「一条没发还报 ok」。
      if (stats.sent >= MAX_PER_RUN) {
        log(`达到单次上限 ${MAX_PER_RUN}，停止。`);
        break;
      }
    }

    log(
      `mode=${DRY_RUN ? "dry-run" : "apply"} status=ok processed=${stats.processed}`,
    );
    for (const d of details) log(`  ${d}`);
    log(
      `sent=${stats.sent} skipped(invisible)=${stats.skippedInvisible} ` +
        `skipped(user-cap)=${stats.skippedUserCap} ` +
        `skipped(already-handled)=${stats.skippedAlreadyHandled} errors=${stats.errors}`,
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
