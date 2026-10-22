#!/usr/bin/env node

/**
 * f1-eval.mjs — F1 抽取评测闸门（PRD v0.3 §5 Phase 1）。
 *
 * 读站长标注好的 docs/f1/eval-set.tsv，对每条笔记跑一次真实抽取，
 * 逐字段比对，算出 stage / delta 的一致率。
 *
 * 闸门规则（PRD 原文：建议 stage、delta 不低于 85%）：
 *   stage 一致率 ≥ 85% 且 delta 一致率 ≥ 85% → 退出码 0，允许批量回填
 *   任一不足 → 退出码 1，禁止批量回填
 *   标注样本为 0 → 退出码 2（不是「通过」，是「没得评」）
 *
 * 标注约定：
 *   空单元格 = 未标注，跳过该字段
 *   `-`      = 原文未提及，应抽成 null；模型抽出任何值都算误报
 *
 * Run:
 *   node --import tsx scripts/f1-eval.mjs
 *   node --import tsx scripts/f1-eval.mjs --gold docs/f1/eval-set.tsv --limit 20
 */

import { PrismaClient } from "../src/generated/prisma/client.js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractTastingFields } from "../src/lib/tasting-extract/extract.ts";
import {
  normalizeDelta,
  normalizeForMatch,
  normalizeStage,
} from "../src/lib/tasting-extract/vocab.ts";

const GATE = 0.85;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const GOLD_PATH = resolve(arg("gold", "docs/f1/eval-set.tsv"));
const LIMIT = Number(arg("limit", "0"));
const OUT_PATH = arg("out", "");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** 解析 TSV：首行表头，其余每行一条。 */
function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row = {};
    header.forEach((h, i) => {
      row[h.trim()] = (cells[i] ?? "").trim();
    });
    return row;
  });
}

/** 与标注值比较。返回 {ok, expected, actual, kind} */
function compareSimple(goldRaw, actual, normalizer) {
  if (!goldRaw) return { skip: true };
  if (goldRaw === "-" || goldRaw === "－" || goldRaw === "—") {
    return { ok: actual == null, expected: null, actual, kind: "absent" };
  }
  const expected = normalizer(goldRaw);
  if (expected == null) {
    return { ok: false, expected: goldRaw, actual, kind: "bad-gold" };
  }
  return { ok: expected === actual, expected, actual, kind: "value" };
}

function compareGrams(goldRaw, actual) {
  if (!goldRaw) return { skip: true };
  if (goldRaw === "-" || goldRaw === "－") {
    return { ok: actual == null, expected: null, actual, kind: "absent" };
  }
  const n = Number(goldRaw.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n)) return { ok: false, expected: goldRaw, actual, kind: "bad-gold" };
  return { ok: actual != null && Math.abs(actual - n) < 1e-6, expected: n, actual, kind: "value" };
}

function splitDesc(raw) {
  return raw
    .split(/[,，、;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function compareDescriptors(goldRaw, actual) {
  if (!goldRaw) return { skip: true };
  if (goldRaw === "-" || goldRaw === "－") {
    return {
      ok: actual.length === 0,
      recall: 1,
      precision: actual.length === 0 ? 1 : 0,
      missing: [],
      extra: actual,
      kind: "absent",
    };
  }
  const gold = splitDesc(goldRaw);
  if (!gold.length) return { skip: true };
  const got = new Set(actual);
  const hit = gold.filter((g) => got.has(g));
  const recall = hit.length / gold.length;
  const precision = actual.length ? hit.length / actual.length : 0;
  return {
    ok: recall === 1 && precision === 1,
    recall,
    precision,
    missing: gold.filter((g) => !got.has(g)),
    extra: actual.filter((a) => !gold.includes(a)),
    kind: "value",
  };
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: missing DATABASE_URL");
    process.exit(1);
  }
  let rows;
  try {
    rows = parseTsv(readFileSync(GOLD_PATH, "utf8"));
  } catch (e) {
    console.error(`ERROR: 读不到标注文件 ${GOLD_PATH}`);
    console.error(String(e?.message || e));
    console.error("先跑 scripts/f1-make-eval-set.mjs，再标注 TSV。");
    process.exit(2);
  }

  if (LIMIT > 0) rows = rows.slice(0, LIMIT);

  const prisma = new PrismaClient();
  const stats = {
    stage: { total: 0, correct: 0, falsePositive: 0, misses: [] },
    delta: { total: 0, correct: 0, falsePositive: 0, misses: [] },
    grams: { total: 0, correct: 0, falsePositive: 0, misses: [] },
    vessel: { total: 0, correct: 0, falsePositive: 0, misses: [] },
    descriptors: { total: 0, exact: 0, recallSum: 0, precisionSum: 0, misses: [] },
    skipped: 0,
    failed: 0,
    needsReview: 0,
  };

  try {
    for (const row of rows) {
      const note = await prisma.tastingNote.findUnique({
        where: { id: row.id },
        select: { id: true, title: true, content: true, createdAt: true },
      });
      if (!note) {
        stats.skipped++;
        log(`跳过 ${row.id}：库里找不到`);
        continue;
      }

      const r = await extractTastingFields({
        title: note.title,
        content: note.content,
      });
      if (!r.ok) {
        stats.failed++;
        log(`抽取失败 ${row.id}：${r.reason}`);
        continue;
      }
      if (r.meta?.needsReview) stats.needsReview++;

      const f = r.fields;

      // ── stage ──
      const cs = compareSimple(row.stage, f.stage, normalizeStage);
      if (!cs.skip) {
        if (cs.kind === "absent") {
          stats.stage.total++;
          if (cs.ok) stats.stage.correct++;
          else {
            stats.stage.falsePositive++;
            stats.stage.misses.push({ id: note.id, gold: "-", got: f.stage, excerpt: note.content.slice(0, 60) });
          }
        } else {
          stats.stage.total++;
          if (cs.ok) stats.stage.correct++;
          else stats.stage.misses.push({ id: note.id, gold: row.stage, got: f.stage, excerpt: note.content.slice(0, 60) });
        }
      }

      // ── delta ──
      const cd = compareSimple(row.delta, f.deltaVsPrev, normalizeDelta);
      if (!cd.skip) {
        stats.delta.total++;
        if (cd.ok) stats.delta.correct++;
        else {
          if (cd.kind === "absent") stats.delta.falsePositive++;
          stats.delta.misses.push({ id: note.id, gold: row.delta, got: f.deltaVsPrev, excerpt: note.content.slice(0, 60) });
        }
      }

      // ── grams ──
      const cg = compareGrams(row.grams, f.grams);
      if (!cg.skip) {
        stats.grams.total++;
        if (cg.ok) stats.grams.correct++;
        else {
          if (cg.kind === "absent") stats.grams.falsePositive++;
          stats.grams.misses.push({ id: note.id, gold: row.grams, got: f.grams, excerpt: note.content.slice(0, 60) });
        }
      }

      // ── vessel ──
      const cv = compareSimple(row.vessel, f.vessel, (s) => normalizeForMatch(s) || null);
      if (!cv.skip) {
        stats.vessel.total++;
        if (cv.ok) stats.vessel.correct++;
        else {
          if (cv.kind === "absent") stats.vessel.falsePositive++;
          stats.vessel.misses.push({ id: note.id, gold: row.vessel, got: f.vessel, excerpt: note.content.slice(0, 60) });
        }
      }

      // ── descriptors ──
      const cdesc = compareDescriptors(row.descriptors, f.descriptors);
      if (!cdesc.skip) {
        stats.descriptors.total++;
        if (cdesc.ok) stats.descriptors.exact++;
        stats.descriptors.recallSum += cdesc.recall ?? 0;
        stats.descriptors.precisionSum += cdesc.precision ?? 0;
        if (!cdesc.ok) {
          stats.descriptors.misses.push({
            id: note.id,
            gold: row.descriptors,
            got: f.descriptors,
            missing: cdesc.missing,
            extra: cdesc.extra,
            excerpt: note.content.slice(0, 60),
          });
        }
      }
    }

    const acc = (s) => (s.total ? s.correct / s.total : 0);

    log("──────────── 结果 ────────────");
    log(`样本：${rows.length} 条，失败 ${stats.failed}，跳过 ${stats.skipped}，需复核 ${stats.needsReview}`);
    log(
      `stage   ${acc(stats.stage).toFixed(3)}  (${stats.stage.correct}/${stats.stage.total})` +
        (stats.stage.falsePositive ? `  误报 ${stats.stage.falsePositive}` : ""),
    );
    log(
      `delta   ${acc(stats.delta).toFixed(3)}  (${stats.delta.correct}/${stats.delta.total})` +
        (stats.delta.falsePositive ? `  误报 ${stats.delta.falsePositive}` : ""),
    );
    log(`grams   ${acc(stats.grams).toFixed(3)}  (${stats.grams.correct}/${stats.grams.total})`);
    log(`vessel  ${acc(stats.vessel).toFixed(3)}  (${stats.vessel.correct}/${stats.vessel.total})`);
    if (stats.descriptors.total) {
      log(
        `descr   exact ${stats.descriptors.exact}/${stats.descriptors.total}  ` +
          `均值 recall ${pct(stats.descriptors.recallSum / stats.descriptors.total)}  ` +
          `precision ${pct(stats.descriptors.precisionSum / stats.descriptors.total)}`,
      );
    }

    // 错例：只打印前 5 条，避免刷屏
    for (const key of ["stage", "delta", "grams", "vessel", "descriptors"]) {
      const m = stats[key].misses;
      if (!m?.length) continue;
      log(`\n${key} 错例（前 ${Math.min(5, m.length)}/${m.length}）：`);
      for (const x of m.slice(0, 5)) {
        log(`  ${x.id}  标注=${x.gold}  抽取=${JSON.stringify(x.got ?? x)}  原文「${x.excerpt}…」`);
      }
    }

    const gateStage = stats.stage.total > 0 && acc(stats.stage) >= GATE;
    const gateDelta = stats.delta.total > 0 && acc(stats.delta) >= GATE;

    log("\n──────────── 闸门 ────────────");
    if (!stats.stage.total && !stats.delta.total) {
      log("没有可评测的标注（stage/delta 全为空或全跳过）→ 不通过");
      process.exitCode = 2;
    } else {
      log(`stage ≥ ${pct(GATE)} : ${gateStage ? "通过" : "未通过"}（${stats.stage.total} 条标注）`);
      log(`delta ≥ ${pct(GATE)} : ${gateDelta ? "通过" : "未通过"}（${stats.delta.total} 条标注）`);
      log(gateStage && gateDelta ? "✅ 允许批量回填" : "❌ 禁止批量回填，先改 prompt 或词表再评");
      process.exitCode = gateStage && gateDelta ? 0 : 1;
    }

    if (OUT_PATH) {
      writeFileSync(
        resolve(OUT_PATH),
        JSON.stringify({ generatedAt: new Date().toISOString(), gate: GATE, stats }, null, 2),
        "utf8",
      );
      log(`报告已写入 ${resolve(OUT_PATH)}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
