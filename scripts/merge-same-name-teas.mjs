#!/usr/bin/env node
/**
 * merge-same-name-teas.mjs —— 批量合并「名称 + 年份 + 品牌」全同的茶品。
 *
 * 站长 2026-10-25：「对于茶品名称完全一样的，请在系统中直接进行合并，
 * 不需要手动操作。」判据（名称+年份+品牌三者全同）已由站长确认。
 *
 * ## 为什么在**容器内**跑
 *
 * 它直接复用应用自己的合并实现（`src/lib/tea-merge.ts`）—— 方向判定、
 * 引用转移、别名合并、统计重算全在那边。**不另写一份 SQL**（两份合并逻辑
 * 必然漂：AGENTS.md 的「数据双轨」）。应用里那个「一键合并」按钮走的是同一
 * 份代码，所以批处理与按钮的结果一致。
 *
 * Run（容器内）：
 *   docker exec puer-hub-app node --import tsx /app/scripts/merge-same-name-teas.mjs
 *   docker exec puer-hub-app node --import tsx /app/scripts/merge-same-name-teas.mjs --apply
 */
import { prisma } from "../src/lib/prisma.ts";
import { cleanTeaName } from "../src/lib/tea-name-clean.ts";
import { groupSameNameTeas } from "../src/lib/tea-merge-rules.ts";
import { mergeTeaPair } from "../src/lib/tea-merge.ts";

const APPLY = process.argv.includes("--apply");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const teas = await prisma.tea.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      name: true,
      year: true,
      brand: true,
      isClassic: true,
      needsReview: true,
      _count: {
        select: { tastingNotes: true, articles: true, cellarItems: true },
      },
    },
  });
  const groups = groupSameNameTeas(teas, cleanTeaName);
  const redundant = groups.reduce((n, g) => n + g.ids.length - 1, 0);
  log(
    `mode=${APPLY ? "apply" : "dry-run"} 同名同年份同品牌：${groups.length} 组，` +
      `多余 ${redundant} 条（总共扫了 ${teas.length} 款）`,
  );

  if (!APPLY) {
    for (const g of groups.slice(0, 15)) {
      const rows = g.ids
        .map((id) => teas.find((t) => t.id === id))
        .filter(Boolean);
      log(
        `  ${g.name}（${g.year} ${g.brand}）×${g.ids.length}` +
          ` → 引用数 ${rows
            .map(
              (r) =>
                r._count.tastingNotes + r._count.articles + r._count.cellarItems,
            )
            .join("/")}` +
          `${rows.some((r) => r.isClassic) ? "（含经典）" : ""}`,
      );
    }
    log("=== Done: status=ok（dry-run，没有写库）===");
    return;
  }

  let merged = 0;
  const errors = [];
  for (const g of groups) {
    let anchor = g.ids[0];
    for (const id of g.ids.slice(1)) {
      try {
        // 方向由 mergeTeaPair 自己判（经典优先、引用多的留下）✅
        const r = await mergeTeaPair(anchor, id);
        merged++;
        anchor = r.keepId;
      } catch (e) {
        errors.push({ id, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  log(
    `status=ok merged=${merged} groups=${groups.length} errors=${errors.length}`,
  );
  if (errors.length) {
    log(`失败明细（前 5 条）：${JSON.stringify(errors.slice(0, 5))}`);
  }
  log("=== Done: status=ok ===");
}

main()
  .catch((e) => {
    console.error(`FATAL: ${e?.stack || e}`);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
