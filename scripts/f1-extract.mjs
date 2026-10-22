#!/usr/bin/env node

/**
 * f1-extract.mjs — F1 批量回填（PRD v0.3 §5 Phase 1）。
 *
 * 只处理「站长原始笔记」：authorId = 站长 且 source ≠ 'article'
 * （source='article' 是帖子/AI 文章镜像，PRD 明确不得进入 F1 抽取）。
 *
 * ## 安全闸（三道）
 *
 * 1. **评测闸**：--apply 前必须存在通过的评测报告（docs/f1/eval-report.json，
 *    由 f1-eval.mjs 产出，stage 与 delta 均 ≥85%）。缺失或不通过 → 拒绝执行。
 *    确实要跳过（例如只是补几条），显式加 --force-ungated，日志会留痕。
 * 2. **默认 dry-run**：不加 --apply 只打印将写什么，不碰库。
 * 3. **可回滚**：每次 --apply 写一份 runs/<时间戳>-rollback.json，
 *    记录每条的前后值，`--rollback <文件>` 可整体还原。
 *
 * ## 写库规则
 *
 * - 被接地校验丢弃的字段**不写**（值仍留在 extractionMeta 里给复核者看）。
 * - 被纠正的字段写纠正后的值。
 * - 原文永远不动（只 UPDATE 新增的六个列）。
 * - 幂等：已有 extractionMeta 的笔记默认跳过（--force 才重抽）。
 *
 * Run:
 *   node --import tsx scripts/f1-extract.mjs                    # dry-run
 *   node --import tsx scripts/f1-extract.mjs --limit 20 --sample 3   # 抽样看效果
 *   node --import tsx scripts/f1-extract.mjs --apply
 *   node --import tsx scripts/f1-extract.mjs --rollback docs/f1/runs/xxx-rollback.json
 */

import { PrismaClient, Prisma } from "../src/generated/prisma/client.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractTastingFields } from "../src/lib/tasting-extract/extract.ts";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const APPLY = has("apply");
const FORCE = has("force");
const FORCE_UNGATED = has("force-ungated");
const AUTHOR_UID = Number(arg("author-uid", "1001"));
const LIMIT = Number(arg("limit", "50"));
const SAMPLE = Number(arg("sample", "0"));
const MIN_CONTENT = Number(arg("min-content", "80"));
const GATE_REPORT = resolve(arg("gate-report", "docs/f1/eval-report.json"));
const RUN_DIR = resolve(arg("run-dir", "docs/f1/runs"));
const ROLLBACK_FILE = arg("rollback", "");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function checkGate() {
  if (FORCE_UNGATED) {
    log("⚠️  --force-ungated：跳过评测闸（本次写入必须由人工担责）");
    return;
  }
  if (!existsSync(GATE_REPORT)) {
    console.error(`ERROR: 找不到评测报告 ${GATE_REPORT}`);
    console.error("先跑 scripts/f1-make-eval-set.mjs 标注，再跑 scripts/f1-eval.mjs --out docs/f1/eval-report.json");
    process.exit(1);
  }
  const r = JSON.parse(readFileSync(GATE_REPORT, "utf8"));
  const acc = (s) => (s.total ? s.correct / s.total : 0);
  const ok = acc(r.stats.stage) >= r.gate && acc(r.stats.delta) >= r.gate;
  if (!ok) {
    console.error(
      `ERROR: 评测未达标 —— stage ${acc(r.stats.stage).toFixed(3)} / delta ${acc(r.stats.delta).toFixed(3)}，` +
        `要求均 ≥ ${r.gate}`,
    );
    process.exit(1);
  }
  log(`评测闸通过：stage ${acc(r.stats.stage).toFixed(3)} / delta ${acc(r.stats.delta).toFixed(3)}`);
}

/** 把抽取结果转成 Prisma data；被丢弃的字段不写。 */
function toDbData(result) {
  const f = result.fields;
  const dropped = result.meta?.dropped ?? {};
  const data = { extractionMeta: result.meta };

  if (f.stage && !dropped.stage) data.stage = f.stage;
  if (f.deltaVsPrev && !dropped.deltaVsPrev) data.deltaVsPrev = f.deltaVsPrev;
  if (f.grams != null && !dropped.grams) data.grams = f.grams;
  if (f.vessel && !dropped.vessel) data.vessel = f.vessel;
  if (f.descriptors.length && !dropped.descriptors) data.descriptors = f.descriptors;
  return data;
}

async function rollback(prisma, file) {
  const rows = JSON.parse(readFileSync(resolve(file), "utf8"));
  log(`回滚 ${rows.length} 条…`);
  let n = 0;
  for (const r of rows) {
    const before = r.before ?? {};
    await prisma.tastingNote.update({
      where: { id: r.id },
      data: {
        stage: before.stage ?? null,
        deltaVsPrev: before.deltaVsPrev ?? null,
        grams: before.grams ?? null,
        vessel: before.vessel ?? null,
        descriptors: before.descriptors ?? Prisma.DbNull,
        extractionMeta: before.extractionMeta ?? Prisma.DbNull,
      },
    });
    n++;
  }
  log(`已回滚 ${n} 条`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: missing DATABASE_URL");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    if (ROLLBACK_FILE) {
      await rollback(prisma, ROLLBACK_FILE);
      return;
    }

    const author = await prisma.user.findFirst({
      where: { uid: AUTHOR_UID },
      select: { id: true, uid: true, username: true, nickname: true },
    });
    if (!author) {
      console.error(`ERROR: uid=${AUTHOR_UID} 不存在`);
      process.exit(1);
    }
    log(`作者：uid=${author.uid} ${author.nickname || author.username}`);

    const where = {
      authorId: author.id,
      source: { not: "article" },
      ...(FORCE ? {} : { extractionMeta: { equals: Prisma.DbNull } }),
    };

    const total = await prisma.tastingNote.count({ where });
    log(`待处理：${total} 条（已有抽取结果的会被跳过${FORCE ? "，但 --force 已开" : ""}）`);

    if (APPLY) checkGate();

    const notes = await prisma.tastingNote.findMany({
      where,
      select: {
        id: true,
        title: true,
        content: true,
        createdAt: true,
        stage: true,
        deltaVsPrev: true,
        grams: true,
        vessel: true,
        descriptors: true,
        extractionMeta: true,
      },
      orderBy: { createdAt: "asc" },
      take: SAMPLE > 0 ? SAMPLE : LIMIT,
    });

    const usable = notes.filter((n) => (n.content || "").trim().length >= MIN_CONTENT);
    log(`其中正文 ≥${MIN_CONTENT} 字：${usable.length} 条`);

    const rollbackRows = [];
    const stats = { ok: 0, failed: 0, review: 0, empty: 0 };

    for (const note of usable) {
      const r = await extractTastingFields({
        title: note.title,
        content: note.content,
      });
      if (!r.ok) {
        stats.failed++;
        log(`失败 ${note.id}：${r.reason}`);
        continue;
      }
      const f = r.fields;
      const hasAny =
        f.stage || f.deltaVsPrev || f.grams != null || f.vessel || f.descriptors.length;
      if (!hasAny) stats.empty++;
      if (r.meta?.needsReview) stats.review++;

      if (!APPLY) {
        log(
          `[dry-run] ${note.id} ${new Date(note.createdAt).toISOString().slice(0, 10)} ` +
            `stage=${f.stage ?? "-"} delta=${f.deltaVsPrev ?? "-"} grams=${f.grams ?? "-"} ` +
            `vessel=${f.vessel ?? "-"} desc=${f.descriptors.join("/") || "-"}` +
            (r.meta?.needsReview ? `  ⚠ ${r.meta.reviewReason}` : ""),
        );
        stats.ok++;
        continue;
      }

      const data = toDbData(r);
      await prisma.tastingNote.update({ where: { id: note.id }, data });
      rollbackRows.push({
        id: note.id,
        before: {
          stage: note.stage,
          deltaVsPrev: note.deltaVsPrev,
          grams: note.grams,
          vessel: note.vessel,
          descriptors: note.descriptors,
          extractionMeta: note.extractionMeta,
        },
      });
      stats.ok++;
      if (stats.ok % 10 === 0) log(`已写 ${stats.ok} 条…`);
    }

    if (APPLY && rollbackRows.length) {
      mkdirSync(RUN_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const path = resolve(RUN_DIR, `${ts}-rollback.json`);
      writeFileSync(path, JSON.stringify(rollbackRows, null, 2), "utf8");
      log(`回滚文件：${path}`);
    }

    log("──────────── 统计 ────────────");
    log(
      `${APPLY ? "已写入" : "可写入"} ${stats.ok} 条，抽取为空 ${stats.empty}，` +
        `需复核 ${stats.review}，失败 ${stats.failed}`,
    );
    if (!APPLY) log("这是 dry-run。确认无误后加 --apply（会先过评测闸）。");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
