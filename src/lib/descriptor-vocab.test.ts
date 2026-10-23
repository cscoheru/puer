import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGE_BRACKET_MIN_SHARE,
  VOCAB_CSV_HEADER,
  ageBracketOf,
  buildVocabRows,
  collectWordStats,
  pickAgeBracket,
  pickFrequentWords,
  renderVocabCsv,
} from "./descriptor-vocab.ts";

// ─── 年份段 ───────────────────────────────────────────────────────────────

test("年份段按茶的年份划，没年份归 any", () => {
  assert.equal(ageBracketOf(2024), "young");
  assert.equal(ageBracketOf(2020), "young");
  assert.equal(ageBracketOf(2019), "mid");
  assert.equal(ageBracketOf(2010), "mid");
  assert.equal(ageBracketOf(2009), "aged");
  assert.equal(ageBracketOf(1990), "aged");
  assert.equal(ageBracketOf(null), "any");
  assert.equal(ageBracketOf(undefined), "any");
});

// ─── 统计 ─────────────────────────────────────────────────────────────────

test("同一个词在生普与熟普里各算各的次数", () => {
  const stats = collectWordStats([
    { descriptors: ["烟香"], tea: { type: "raw", year: 1995 } },
    { descriptors: ["烟香"], tea: { type: "raw", year: 1996 } },
    { descriptors: ["烟香"], tea: { type: "ripe", year: 2015 } },
  ]);
  const e = stats.get("烟香");
  assert.ok(e);
  assert.equal(e.total, 3);
  assert.equal(e.cats.raw.count, 2);
  assert.equal(e.cats.ripe.count, 1);
  assert.equal(e.cats.raw.brackets.aged, 2);
  assert.equal(e.cats.ripe.brackets.mid, 1);
});

test("tea.type 不是 ripe 一律当生普，缺 tea 也不炸", () => {
  const stats = collectWordStats([
    { descriptors: ["回甘"] },
    { descriptors: ["回甘"], tea: null },
    { descriptors: ["回甘"], tea: { type: "raw", year: 2001 } },
  ]);
  const e = stats.get("回甘");
  assert.ok(e);
  assert.equal(e.cats.raw.count, 3);
  assert.equal(e.cats.ripe.count, 0);
});

test("descriptors 不是数组或含非字符串时跳过", () => {
  const stats = collectWordStats([
    { descriptors: undefined, tea: { type: "raw", year: 2001 } },
    { descriptors: "烟香" as unknown, tea: { type: "raw", year: 2001 } },
    { descriptors: [123, null, "  "] as unknown, tea: { type: "raw", year: 2001 } },
  ]);
  assert.equal(stats.size, 0);
});

test("超过 20 个字的描述词不算词", () => {
  const long = "一".repeat(21);
  const stats = collectWordStats([
    { descriptors: [long, "正常"], tea: { type: "raw", year: 2001 } },
  ]);
  assert.equal(stats.has(long), false);
  assert.equal(stats.get("正常")?.total, 1);
});

test("高频词筛选：够次数的留下，按次数降序，超量截断", () => {
  const stats = collectWordStats([
    { descriptors: ["a", "b", "c"], tea: { type: "raw", year: 2001 } },
    { descriptors: ["a", "b"], tea: { type: "raw", year: 2001 } },
    { descriptors: ["c"], tea: { type: "raw", year: 2001 } },
  ]);
  const kept = pickFrequentWords(stats, { minCount: 2, limit: 10 });
  assert.deepEqual(
    kept.map(([t]) => t),
    ["a", "b", "c"],
  );

  const limited = pickFrequentWords(stats, { minCount: 1, limit: 2 });
  assert.equal(limited.length, 2);
});

// ─── 年份段取值 ───────────────────────────────────────────────────────────

test("分布集中时采信多数派，分布太散归 any", () => {
  assert.equal(pickAgeBracket({ aged: 10, mid: 1 }), "aged");
  assert.equal(pickAgeBracket({ aged: 6, mid: 4 }), "aged");
  assert.equal(pickAgeBracket({ aged: 5, mid: 5 }), "any");
  assert.equal(pickAgeBracket({}), "any");
});

test("阈值就是那个 0.6，改阈值行为跟着变", () => {
  assert.equal(AGE_BRACKET_MIN_SHARE, 0.6);
  assert.equal(pickAgeBracket({ aged: 5, mid: 4 }, 0.5), "aged");
});

// ─── 拼行（这里是 2026-10-23 那次翻车的地方）────────────────────────────

test("一个词出现过的每个生熟各出一行，次数与年份段各算各的", () => {
  const stats = collectWordStats([
    // 生普：全是老茶
    { descriptors: ["烟香"], tea: { type: "raw", year: 1995 } },
    { descriptors: ["烟香"], tea: { type: "raw", year: 1996 } },
    { descriptors: ["烟香"], tea: { type: "raw", year: 1997 } },
    // 熟普：全是新茶
    { descriptors: ["烟香"], tea: { type: "ripe", year: 2021 } },
  ]);
  const rows = buildVocabRows([...stats.entries()]);

  assert.equal(rows.length, 2);

  const raw = rows.find((r) => r.category === "raw");
  const ripe = rows.find((r) => r.category === "ripe");
  assert.ok(raw && ripe);

  // 次数是**该生熟**的次数，不是跨生熟的总次数
  assert.equal(raw.count, 3);
  assert.equal(ripe.count, 1);

  // 年份段是**该生熟**的年份段，不是合并后的分布
  assert.equal(raw.ageBracket, "aged");
  assert.equal(ripe.ageBracket, "young");
});

test("只在生普里出现过的词不产出生普以外的行", () => {
  const stats = collectWordStats([
    { descriptors: ["堆味"], tea: { type: "ripe", year: 2018 } },
  ]);
  const rows = buildVocabRows([...stats.entries()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, "ripe");
  assert.equal(rows[0].count, 1);
});

test("模型判了维度就用它的，没判到退回「通用」并标 seed", () => {
  const stats = collectWordStats([
    { descriptors: ["蜜香"], tea: { type: "raw", year: 2015 } },
  ]);
  const rows = buildVocabRows([...stats.entries()], new Map([["蜜香", "aroma" as const]]));
  assert.equal(rows[0].dim, "aroma");
  assert.equal(rows[0].source, "llm");

  const fallback = buildVocabRows([...stats.entries()]);
  assert.equal(fallback[0].dim, "any");
  assert.equal(fallback[0].source, "seed");
});

test("空输入产出空行列表（而不是抛异常）", () => {
  assert.deepEqual(buildVocabRows([]), []);
  assert.deepEqual(buildVocabRows([...collectWordStats([]).entries()]), []);
});

// ─── 报告 ─────────────────────────────────────────────────────────────────

test("CSV 带 BOM、表头齐全、词里含逗号要加引号", () => {
  const csv = renderVocabCsv([
    { tag: "香,甜", category: "raw", ageBracket: "aged", dim: "aroma", count: 3, source: "llm" },
  ]);
  assert.ok(csv.startsWith("﻿"), "Excel 需要 BOM 才认 UTF-8");
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], VOCAB_CSV_HEADER.join(","));
  assert.equal(lines[1], '"香,甜",raw,aged,aroma,3');
});

test("CSV 里不出现 source 列 —— 那是库里的字段，不是给站长看的", () => {
  const csv = renderVocabCsv([
    { tag: "蜜香", category: "raw", ageBracket: "any", dim: "aroma", count: 5, source: "llm" },
  ]);
  assert.equal(csv.includes("source"), false);
  assert.equal(csv.includes("llm"), false);
});
