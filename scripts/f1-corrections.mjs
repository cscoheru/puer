#!/usr/bin/env node

/**
 * f1-corrections.mjs — 人工修正 F1 抽取结果（导出 / 回写）。
 *
 * 站长不想逐条标注，那就反过来：先让模型把全部笔记抽完，站长只看
 * 不对的那几条。这个脚本负责两件事：
 *
 *   --export  把库里已抽取的笔记导成一张 TSV（含每条的「来源」摘要，
 *             一眼能看出哪些值是原文写的、哪些是推断/默认的）
 *   --import  把改过的 TSV 读回来，只更新真正变了的字段，
 *             并把该字段的 basis 标成 manual（默认 dry-run，加 --commit 才写）
 *
 * 单元格约定（与评测表一致）：
 *   留空 = 不改
 *   `-`  = 清空该字段（写回 null）
 *   实值 = 改成这个值
 *
 * 与 f1-extract.mjs 一样走参数化 SQL：生产镜像里的 Prisma Client 不认识
 * 这六个新列，修正操作不该依赖重新构建。
 *
 * Run:
 *   node --import tsx scripts/f1-corrections.mjs --export
 *   node --import tsx scripts/f1-corrections.mjs --import docs/f1/corrections.tsv --commit
 */

import { PrismaClient } from "../src/generated/prisma/client.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { normalizeDelta, normalizeStage } from "../src/lib/tasting-extract/vocab.ts";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const AUTHOR_UID = Number(arg("author-uid", "1001"));
const LIMIT = Number(arg("limit", "0"));

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function stripToText(s) {
  return String(s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tsvCell(s) {
  return String(s ?? "").replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

const BASIS_LABEL = { stated: "原文", inferred: "推断", default: "默认", manual: "人工" };

function basisSummary(meta) {
  const b = meta?.basis ?? {};
  return ["stage", "deltaVsPrev", "grams", "vessel"]
    .filter((k) => b[k])
    .map((k) => `${k}:${BASIS_LABEL[b[k]] ?? b[k]}`)
    .join(" ");
}

function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0].split("\t").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row = {};
    header.forEach((h, i) => {
      row[h] = (cells[i] ?? "").trim();
    });
    return row;
  });
}

const UPDATE_SQL = `
  UPDATE tasting_notes SET
    stage = $2, "deltaVsPrev" = $3, grams = $4, vessel = $5,
    descriptors = $6::jsonb, "extractionMeta" = $7::jsonb
  WHERE id = $1
`;

async function exportSheet(prisma, outPath) {
  const author = await prisma.user.findFirst({
    where: { uid: AUTHOR_UID },
    select: { id: true, uid: true, nickname: true, username: true },
  });
  if (!author) throw new Error(`uid=${AUTHOR_UID} 不存在`);

  // 只有站长的笔记被抽取过，所以不再按作者过滤 —— 直接取所有已抽取的。
  const notes = await prisma.$queryRawUnsafe(
    `SELECT n.id, n.title, n.content, n."createdAt",
            n.stage, n."deltaVsPrev", n.grams, n.vessel, n.descriptors, n."extractionMeta",
            t.name AS "teaName"
     FROM tasting_notes n
     LEFT JOIN teas t ON t.id = n."teaId"
     WHERE n.source <> 'article'
       AND n."extractionMeta" IS NOT NULL
     ORDER BY n."createdAt" ASC
     ${LIMIT > 0 ? "LIMIT $1" : ""}`,
    ...(LIMIT > 0 ? [LIMIT] : []),
  );

  // 「太长了没法过」→ 只导最值得人看的那些行。
  // 风险判定：阶段不是「适饮」（适饮是默认判断，错得起）、有与上次的比较、
  // 模型说过与原文冲突、以及投茶量补了默认值但原文其实写了数字。
  const RISKY = new Set();
  const reasons = new Map();
  const addRisk = (id, why) => {
    RISKY.add(id);
    if (!reasons.has(id)) reasons.set(id, []);
    reasons.get(id).push(why);
  };
  for (const n of notes) {
    if (n.stage && n.stage !== "drinking") {
      addRisk(n.id, n.stage === "declining" ? "判了走下坡" : n.stage === "peak" ? "判了巅峰期" : "判了上升期");
    }
    if (n.deltaVsPrev) {
      addRisk(n.id, n.deltaVsPrev === "worse" ? "比上次差" : n.deltaVsPrev === "better" ? "比上次好" : "与上次持平");
    }
    if (n.extractionMeta?.needsReview) addRisk(n.id, "模型与原文有出入");
    const basis = n.extractionMeta?.basis ?? {};
    if (basis.grams === "default" && /[0-9]+\s*(克|g)/i.test(stripToText(n.content))) {
      addRisk(n.id, "投茶量补了默认但原文有数字");
    }
  }

  const onlyRisky = (arg("filter", "") || "").toLowerCase() === "risky";
  const rowsOut = onlyRisky ? notes.filter((n) => RISKY.has(n.id)) : notes;
  // 风险高的排前面：先看结论性强的（走下坡/巅峰/比上次差），最后才是投茶量这类细节
  const severity = (n) => {
    const r = reasons.get(n.id) ?? [];
    let s = 0;
    if (r.some((x) => x.includes("走下坡") || x.includes("巅峰"))) s += 8;
    if (r.some((x) => x.includes("比上次差"))) s += 6;
    if (r.some((x) => x.includes("有出入"))) s += 5;
    if (r.some((x) => x.includes("上升期"))) s += 4;
    if (r.some((x) => x.includes("比上次好") || x.includes("持平"))) s += 3;
    if (r.some((x) => x.includes("投茶量"))) s += 1;
    return s;
  };
  rowsOut.sort((a, b) => severity(b) - severity(a) || String(a.createdAt).localeCompare(String(b.createdAt)));

  const header = ["id", "日期", "茶品", "标题", "正文摘要", "stage", "delta", "grams", "vessel", "descriptors", "当前来源", "风险点"];
  const lines = rowsOut.map((n) =>
    [
      n.id,
      new Date(n.createdAt).toISOString().slice(0, 10),
      n.teaName ?? "",
      n.title,
      stripToText(n.content).slice(0, 200),
      n.stage ?? "",
      n.deltaVsPrev ?? "",
      n.grams ?? "",
      n.vessel ?? "",
      Array.isArray(n.descriptors) ? n.descriptors.join(",") : "",
      basisSummary(n.extractionMeta),
      (reasons.get(n.id) ?? []).join("、"),
    ]
      .map(tsvCell)
      .join("\t"),
  );

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${header.join("\t")}\n${lines.join("\n")}\n`, "utf8");
  log(`已导出 ${rowsOut.length} 条 → ${outPath}`);
  if (onlyRisky) {
    log(`只含高风险行（${notes.length} 条里挑出 ${rowsOut.length} 条），按严重度排序`);
    log("「风险点」列说明了每条为什么值得你看一眼。");
  }
  log("只改最后五列中被模型写错的地方；留空=不改，填 - = 清空。");
}

async function applySheet(prisma, inPath) {
  const rows = parseTsv(readFileSync(inPath, "utf8"));
  log(`读入 ${rows.length} 行`);

  const changed = [];
  const skipped = [];
  const errors = [];

  for (const row of rows) {
    if (!row.id) continue;
    const found = await prisma.$queryRawUnsafe(
      `SELECT id, stage, "deltaVsPrev", grams, vessel, descriptors, "extractionMeta"
       FROM tasting_notes WHERE id = $1`,
      row.id,
    );
    const note = found?.[0];
    if (!note) {
      skipped.push(`${row.id} 库里找不到`);
      continue;
    }

    const meta = note.extractionMeta && typeof note.extractionMeta === "object" ? { ...note.extractionMeta } : {};
    const basis = { ...(meta.basis ?? {}) };
    const next = {
      stage: note.stage,
      deltaVsPrev: note.deltaVsPrev,
      grams: note.grams,
      vessel: note.vessel,
      descriptors: note.descriptors,
    };
    const before = { ...next };
    let touched = false;

    const mark = (key) => {
      basis[key] = "manual";
      touched = true;
    };

    if (row.stage !== undefined && row.stage !== "") {
      if (row.stage === "-") {
        if (next.stage !== null) { next.stage = null; mark("stage"); }
      } else {
        const v = normalizeStage(row.stage);
        if (!v) errors.push(`${row.id} stage 无法识别：${row.stage}`);
        else if (v !== next.stage) { next.stage = v; mark("stage"); }
      }
    }

    if (row.delta !== undefined && row.delta !== "") {
      if (row.delta === "-") {
        if (next.deltaVsPrev !== null) { next.deltaVsPrev = null; mark("deltaVsPrev"); }
      } else {
        const v = normalizeDelta(row.delta);
        if (!v) errors.push(`${row.id} delta 无法识别：${row.delta}`);
        else if (v !== next.deltaVsPrev) { next.deltaVsPrev = v; mark("deltaVsPrev"); }
      }
    }

    if (row.grams !== undefined && row.grams !== "") {
      if (row.grams === "-") {
        if (next.grams !== null) { next.grams = null; mark("grams"); }
      } else {
        const v = Number(row.grams.replace(/[^\d.]/g, ""));
        if (!Number.isFinite(v) || v <= 0 || v > 100) errors.push(`${row.id} grams 不合理：${row.grams}`);
        else if (next.grams === null || Math.abs(next.grams - v) > 1e-6) { next.grams = v; mark("grams"); }
      }
    }

    if (row.vessel !== undefined && row.vessel !== "") {
      if (row.vessel === "-") {
        if (next.vessel !== null) { next.vessel = null; mark("vessel"); }
      } else if (row.vessel !== next.vessel) {
        next.vessel = row.vessel;
        mark("vessel");
      }
    }

    if (row.descriptors !== undefined && row.descriptors !== "") {
      const currentArr = Array.isArray(next.descriptors) ? next.descriptors : [];
      const current = currentArr.join(",");
      if (row.descriptors === "-") {
        if (current) { next.descriptors = null; mark("descriptors"); }
      } else {
        // 顿号可能就在描述词内部（模型写的「甜、柔且均衡」是一个词）。
        // 所以只按逗号分段；每一段若在库里原样存在就整段保留，
        // 只有当它能被拆成库里已有的词时，才按顿号拆开。
        const whole = row.descriptors.trim();
        const list = [];
        for (const piece of whole.split(/[,，]/).map((s) => s.trim()).filter(Boolean)) {
          if (currentArr.includes(piece)) {
            list.push(piece);
            continue;
          }
          const sub = piece.split(/[、;；\s]+/).map((s) => s.trim()).filter(Boolean);
          if (sub.length > 1 && sub.some((x) => currentArr.includes(x))) list.push(...sub);
          else list.push(piece);
        }
        if (list.join(",") !== current) { next.descriptors = list; mark("descriptors"); }
      }
    }

    if (!touched) continue;
    const diffs = Object.keys(next)
      .filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]))
      .map((k) => `${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(next[k])}`);
    log(`  改 ${note.id.slice(0, 8)} ${diffs.join("; ")}`);
    changed.push({ id: note.id, before, next, meta: { ...meta, basis } });
  }

  log(`需要更新 ${changed.length} 条，未识别 ${errors.length} 条，跳过 ${skipped.length} 条`);
  for (const e of errors.slice(0, 10)) log(`  ! ${e}`);
  for (const s of skipped.slice(0, 10)) log(`  - ${s}`);

  if (!changed.length) return;

  if (!has("commit")) {
    log("dry-run：未写库。确认后加 --commit。");
    return;
  }

  for (const c of changed) {
    await prisma.$executeRawUnsafe(
      UPDATE_SQL,
      c.id,
      c.next.stage,
      c.next.deltaVsPrev,
      c.next.grams,
      c.next.vessel,
      c.next.descriptors == null ? null : JSON.stringify(c.next.descriptors),
      JSON.stringify(c.meta),
    );
  }
  const outPath = resolve("docs/f1/runs");
  mkdirSync(outPath, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rollback = resolve(outPath, `${ts}-corrections-rollback.json`);
  writeFileSync(rollback, JSON.stringify(changed.map((c) => ({ id: c.id, before: c.before })), null, 2), "utf8");
  log(`已更新 ${changed.length} 条；回滚文件 ${rollback}`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: missing DATABASE_URL");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const importPath = arg("import", "");
    if (importPath) {
      await applySheet(prisma, resolve(importPath));
    } else {
      const out = resolve(arg("out", "docs/f1/corrections.tsv"));
      await exportSheet(prisma, out);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
