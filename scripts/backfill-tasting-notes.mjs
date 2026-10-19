/**
 * backfill-tasting-notes.mjs — 为「已发布 + 关联茶品」的存量帖子补建镜像品鉴笔记。
 *
 * 背景：跟进帖 = 一篇独立的品鉴笔记（只是关联了具体茶品）。该双写是后来才加的，
 * 功能上线前已发布的跟进帖只存在于 articles 表，tasting_notes 里没有对应条目 ——
 * 茶档案页的品鉴时间线上看不到它们。这个脚本把存量补齐。
 *
 * 用法（容器内，cron-task.sh 同款入口）：
 *   docker exec puer-hub-app ./node_modules/.bin/tsx scripts/backfill-tasting-notes.mjs \
 *     [--limit N] [--dry-run] [--recompute-only] [--reconcile-only] [--reconcile]
 *
 *   --limit N        一次最多建 N 条（0 = 不限制，默认 30）
 *   --dry-run        只报告将做什么，不写库
 *   --recompute-only 只重算茶品的 tastingNoteCount/avgRating，不建笔记
 *   --reconcile-only 只清理孤儿镜像笔记（删行），不建笔记
 *   --reconcile      在默认建镜像之后**追加**一次孤儿清理（破坏性，默认不跑）
 *
 * 建议的上线顺序：先 --dry-run 看数量 → 再跑默认模式建镜像 → 核对 DB 数量 →
 * 确认无误后再单独跑 --reconcile-only 清孤儿。
 *
 * 三层幂等，重复跑安全：
 *   1. 本脚本：先把已有镜像的 sourceId 装进 Set，跳过它们；
 *   2. 运行期路径：`syncTastingNoteForArticle` 里的 findFirst 前置检查；
 *   3. 统计口径：`recomputeTeaStats` 按实际条数 **set**（不是 increment），
 *      所以即使重跑也不会把 tastingNoteCount 越加越多，历史漂移还会被顺带修好。
 *
 * 故意不 import `@/lib/*`：`npm run test:unit` 用的 `node --test` 不解析 tsconfig
 * 的 `@/` 别名，`scripts/*.mjs` 在 tsx 下也可能拿不到同样的映射。决策逻辑从**纯模块**
 * `src/lib/tasting-note-plan.ts` 用相对路径引入（零 @/ 依赖），保证脚本与运行期
 * 路径不会漂移；`recomputeTeaStats` 在这里内联复刻一份，代价是十行重复代码，
 * 换来的是不会在凌晨三点因为别名解析失败而炸掉。
 */
import { PrismaClient } from "../src/generated/prisma/client.js";
import {
  ARTICLE_NOTE_SOURCE,
  planArticleTastingNote,
} from "../src/lib/tasting-note-plan.ts";
import { isTastingDraftId } from "../src/lib/tea-drafts/id.ts";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const numArg = (flag, dflt) => {
  const i = args.indexOf(flag);
  if (i < 0) return dflt;
  const n = Number(args[i + 1]);
  // `|| dflt` 会把 --limit 0 也变成默认值（0 被当成 falsy），
  // 而 0 在这里语义是「不限制」——必须显式区分「没给」和「给了非法值」。
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

const LIMIT = numArg("--limit", 30);
const DRY_RUN = has("--dry-run");
const RECOMPUTE_ONLY = has("--recompute-only");
const RECONCILE_ONLY = has("--reconcile-only");
// 孤儿清理是**破坏性**的（删行），所以默认模式不跑，必须显式加 --reconcile。
// 首次上线时先跑默认模式建镜像，确认无误后再单独跑一次 --reconcile 清孤儿。
const RECONCILE = has("--reconcile");
const BATCH = 500;

function makePrisma() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: missing required env DATABASE_URL.");
    process.exit(1);
  }
  return new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * 内联版 recomputeTeaStats（源：`src/lib/tea-stats.ts`）。
 * 按实际条数 set 而非 increment —— 这是整个方案幂等的地基。
 */
async function recomputeTeaStats(prisma, teaId) {
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

/** 扫一遍所有镜像笔记所在的茶品并重算（--recompute-only） */
async function recomputeAll(prisma) {
  const teaIds = new Set();
  let cursor;
  do {
    const page = await prisma.tastingNote.findMany({
      where: { source: ARTICLE_NOTE_SOURCE },
      // 必须 select id —— 翻页游标就取自它（缺了 page[len-1].id 是 undefined，
      // 循环会在第一页后静默结束，只重算 500 条以内的茶品）。
      select: { id: true, teaId: true },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    page.forEach((n) => teaIds.add(n.teaId));
    cursor = page.length === BATCH ? page[page.length - 1].id : undefined;
  } while (cursor);
  log(`  涉及 ${teaIds.size} 个茶品`);
  let ok = 0;
  for (const teaId of teaIds) {
    if (!DRY_RUN) await recomputeTeaStats(prisma, teaId);
    ok++;
  }
  log(`  ${DRY_RUN ? "[dry] 将重算" : "已重算"} ${ok} 个茶品的 tastingNoteCount/avgRating`);
}

/**
 * 修复（--reconcile-only / --reconcile）：
 *  1. 孤儿清理：TastingNote 与 Article 之间**没有外键**，删 Article 不会级联。
 *     任何漏掉的删除路径都会留下一条指向已删帖子的笔记。这是那张安全网。
 *  2. 重复清理：`sourceId` 只有普通索引、没有唯一约束，并发发布可能建出两条
 *     同样的镜像 → 计数翻倍、时间线出现孪生条目。保留最早的一条，删掉其余。
 */
async function reconcileOrphans(prisma) {
  let cursor;
  let scanned = 0;
  let removed = 0;
  let deduped = 0;
  const touchedTeas = new Set();
  // 同一个 sourceId 可能在不同分页里出现，所以 seen 要跨页累计
  const seenSourceIds = new Map();
  do {
    const page = await prisma.tastingNote.findMany({
      where: { source: ARTICLE_NOTE_SOURCE },
      select: { id: true, teaId: true, sourceId: true, createdAt: true },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (page.length === 0) break;
    scanned += page.length;
    const ids = page.map((n) => n.sourceId).filter(Boolean);
    const alive = new Set();
    if (ids.length > 0) {
      const arts = await prisma.article.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      });
      arts.forEach((a) => alive.add(a.id));
    }
    const orphans = page.filter((n) => !n.sourceId || !alive.has(n.sourceId));
    if (orphans.length > 0) {
      orphans.forEach((n) => touchedTeas.add(n.teaId));
      log(`  发现 ${orphans.length} 条孤儿笔记（源帖已不存在）`);
      if (!DRY_RUN) {
        await prisma.tastingNote.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
      }
      removed += orphans.length;
    }

    // 同一 sourceId 的重复镜像：保留最早创建的
    const dupes = [];
    for (const n of page) {
      if (!n.sourceId) continue;
      const prev = seenSourceIds.get(n.sourceId);
      if (prev) {
        // 保留 createdAt 早的那条
        const [keep, drop] = prev.createdAt <= n.createdAt ? [prev, n] : [n, prev];
        seenSourceIds.set(n.sourceId, keep);
        dupes.push(drop);
      } else {
        seenSourceIds.set(n.sourceId, n);
      }
    }
    if (dupes.length > 0) {
      dupes.forEach((n) => touchedTeas.add(n.teaId));
      log(`  发现 ${dupes.length} 条重复镜像（同一源帖建了多条）`);
      if (!DRY_RUN) {
        await prisma.tastingNote.deleteMany({ where: { id: { in: dupes.map((d) => d.id) } } });
      }
      deduped += dupes.length;
    }
    cursor = page.length === BATCH ? page[page.length - 1].id : undefined;
  } while (cursor);

  if (!DRY_RUN) {
    for (const teaId of touchedTeas) await recomputeTeaStats(prisma, teaId);
  }
  log(`  扫描 ${scanned} 条，${DRY_RUN ? "[dry] 将删除" : "已删除"} ${removed} 条孤儿，${deduped} 条重复`);
}

async function backfill(prisma) {
  // Article 与 TastingNote 之间没有 Prisma 关系，无法用 `tastingNotes: { none: {} }`
  // 表达「还没有镜像的帖子」，只能查出来后在代码里做差集。
  const already = new Set();
  let noteCursor;
  for (;;) {
    const page = await prisma.tastingNote.findMany({
      where: { source: ARTICLE_NOTE_SOURCE },
      select: { id: true, sourceId: true },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(noteCursor ? { skip: 1, cursor: { id: noteCursor } } : {}),
    });
    if (page.length === 0) break;
    page.forEach((n) => n.sourceId && already.add(n.sourceId));
    if (page.length < BATCH) break;
    noteCursor = page[page.length - 1].id;
  }

  log(`=== 已有镜像笔记 ${already.size} 条 ===`);

  let created = 0;
  let skipped = 0;
  let failed = 0;
  let scanned = 0;

  // 一次性取候选集再切片（仿 backfill-videos.mjs 的 `take: 500`），不用游标翻页：
  // `orderBy: { createdAt }` 与 `cursor: { id }` 混用时，createdAt 相同的行会造成
  // 重复/漏读，而 createdAt 在跟进帖里天然大量重复。一次性取全再按 createdAt 排，
  // 对这个量级（存量跟进帖数百条）完全够用。
  const rows = await prisma.article.findMany({
    // 私密帖不镜像（镜像即泄露：茶档案页取笔记没有任何可见性过滤）
    where: { teaId: { not: null }, status: "published", visibility: { not: "private" } },
    select: {
      id: true, title: true, content: true, summary: true, images: true,
      videoUrl: true, authorId: true, teaId: true, status: true,
      visibility: true, createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });
  scanned = rows.length;

  for (const row of rows) {
    // LIMIT=0 表示不限制（0 被 || 吞掉的老问题已修）
    if (LIMIT > 0 && created >= LIMIT) break;
    // 自动草稿是从既有笔记改写出来的，镜像它会给同一篇笔记造出孪生条目。
    // 规划器里也有这道闸（按 id 前缀），这里先过滤是为了省掉一次无用查询。
    if (isTastingDraftId(row.id)) continue;
    if (already.has(row.id)) continue;

    const plan = planArticleTastingNote(row, { alreadySynced: false });
    if (plan.action === "skip") {
      skipped++;
      continue;
    }
    if (DRY_RUN) {
      created++;
      log(`  [dry] 将创建 ${row.id} “${row.title.slice(0, 30)}” → tea=${row.teaId}`);
      continue;
    }
    // 单行失败不能中断整批：一条历史数据超标（例如 summary 超过 500 字列宽）、
    // 或运行期间茶品被删，都不该让后面的行一条都补不上。失败计数并继续。
    try {
      await prisma.$transaction(async (tx) => {
        await tx.tastingNote.create({ data: plan.data });
        await recomputeTeaStats(tx, plan.data.teaId);
      });
      already.add(row.id);
      created++;
      log(`  ✓ ${row.id} “${row.title.slice(0, 30)}” → tea=${row.teaId}`);
    } catch (e) {
      failed++;
      log(`  ✗ ${row.id} “${row.title.slice(0, 30)}” → ${e?.message || e}`);
    }
  }

  log(`=== 扫描 ${scanned} 篇，创建 ${DRY_RUN ? "[dry] " : ""}${created}，跳过 ${skipped}，失败 ${failed} ===`);
}

async function main() {
  const prisma = makePrisma();
  try {
    if (RECOMPUTE_ONLY) {
      log("=== 仅重算统计 ===");
      await recomputeAll(prisma);
    } else if (RECONCILE_ONLY) {
      log("=== 仅清理孤儿镜像笔记 ===");
      await reconcileOrphans(prisma);
    } else {
      await backfill(prisma);
      // 孤儿清理是删行，默认**不跑**：先跑默认模式建镜像、核对数量，
      // 确认无误后再单独跑一次 --reconcile 清孤儿。
      if (RECONCILE) {
        await reconcileOrphans(prisma);
      } else {
        log("（跳过孤儿清理；确认镜像无误后加 --reconcile 单独跑）");
      }
    }
    log("=== Done ===");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
