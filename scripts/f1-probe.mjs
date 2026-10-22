#!/usr/bin/env node

/**
 * f1-probe.mjs — 抽样看 F1 抽取效果（只读，不写库）。
 *
 * 输入是 f1-make-eval-set.mjs 产出的 eval-set.jsonl（含正文），
 * 因此**不需要数据库**，可以在还没迁移的生产环境里先跑，用来判断
 * prompt 与阈值是否合适。
 *
 * Run:
 *   node --import tsx scripts/f1-probe.mjs /tmp/f1/eval-set.jsonl --limit 8
 */

import { readFileSync } from "node:fs";
import { extractTastingFields } from "../src/lib/tasting-extract/extract.ts";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const file = process.argv[2];
const LIMIT = Number(arg("limit", "8"));
const OFFSET = Number(arg("offset", "0"));

if (!file) {
  console.error("用法: node --import tsx scripts/f1-probe.mjs <eval-set.jsonl> [--limit N] [--offset N]");
  process.exit(1);
}

const BASIS_LABEL = { stated: "原文", inferred: "推断", default: "默认", manual: "人工" };

function stripToText(s) {
  return String(s ?? "").replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
}

const rows = readFileSync(file, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
  .slice(OFFSET, OFFSET + LIMIT);

let ok = 0;
let failed = 0;

for (const row of rows) {
  const r = await extractTastingFields({ title: row.title, content: row.content });
  console.log("\n" + "─".repeat(72));
  console.log(`${row.createdAt?.slice(0, 10)}  ${row.teaName ?? "-"}  「${row.title ?? ""}」`);
  console.log(`原文：${stripToText(row.content).slice(0, 120)}…`);
  if (!r.ok) {
    failed++;
    console.log(`✖ 失败：${r.reason}`);
    continue;
  }
  ok++;
  const b = r.meta?.basis ?? {};
  const f = r.fields;
  const tag = (k, v) => (v ? ` (${BASIS_LABEL[b[k]] ?? b[k]})` : "");
  console.log(
    `→ stage=${f.stage ?? "-"}${tag("stage", f.stage)}  ` +
      `delta=${f.deltaVsPrev ?? "-"}${tag("deltaVsPrev", f.deltaVsPrev)}  ` +
      `grams=${f.grams ?? "-"}${tag("grams", f.grams)}  ` +
      `vessel=${f.vessel ?? "-"}${tag("vessel", f.vessel)}`,
  );
  console.log(`→ descriptors=${f.descriptors.join("/") || "-"}`);
  if (r.meta?.dropped && Object.keys(r.meta.dropped).length) {
    console.log(`→ 复核：${r.meta.reviewReason}`);
  }
  if (r.meta?.corrected && Object.keys(r.meta.corrected).length) {
    console.log(`→ 纠正：${Object.values(r.meta.corrected).join("；")}`);
  }
}

console.log("\n" + "─".repeat(72));
console.log(`完成 ${ok} 条，失败 ${failed} 条`);
