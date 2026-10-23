#!/usr/bin/env node

/**
 * seed-descriptor-vocab.mjs — 描述词库播种（PRD v0.3 §5 Phase 2）。
 *
 * 词库的**种子**来自站长 1672 条笔记里的高频描述词 —— 那些词是站长
 * 真正在用的语汇，比任何通用词表都贴切（PRD §6：「词库由站长提供」）。
 *
 * ## 三步
 *
 *   1. 统计：从站长笔记的 descriptors 里数词频，同时记下每个词出现在
 *      哪些生熟、哪些年份段的茶上。
 *   2. 分类：把高频词一次性丢给 LLM，按四维（香气/滋味/水路/体感）
 *      粗分类。**这一步是模型判断，不保证准** —— 所以默认 dry-run，
 *      报告给站长核对之后再 --apply。
 *   3. 落库：幂等 upsert 进 descriptor_vocab。
 *
 * ## 生熟与年份段不是模型判的
 *
 * 生熟（raw/ripe）跟年份段都从**笔记所属的茶**直接读出来 —— 那是
 * 数据库里的确定事实，不需要模型猜。只有「这个词属于哪个维度」是
 * 主观判断，才交给模型。
 *
 * ## 用参数化 SQL 还是 Prisma？
 *
 * 用 Prisma —— descriptor_vocab 是**新表**，生产镜像里的 Client 不认识它，
 * 所以这个脚本只能在**新镜像**上跑（跟迁移一起发布）。这里不像 f1-extract
 * 那样需要兼容旧镜像。
 *
 * Run:
 *   node --import tsx scripts/seed-descriptor-vocab.mjs              # dry-run
 *   node --import tsx scripts/seed-descriptor-vocab.mjs --limit 120
 *   node --import tsx scripts/seed-descriptor-vocab.mjs --apply
 *   node --import tsx scripts/seed-descriptor-vocab.mjs --out docs/f1/vocab-preview.csv
 */

import { PrismaClient } from "../src/generated/prisma/client.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { callLLM, minimaxTarget, glmTarget } from "../src/lib/llm-provider.ts";
import { DIM_LABELS as APP_DIM_LABELS } from "../src/lib/cellar.ts";
import { editorAuthorUids } from "../src/lib/editor-line.ts";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const APPLY = has("apply");
/** 取多少个高频词。太多会让分类请求超出模型能一次吃下的量。 */
const LIMIT = Number(arg("limit", "120"));
/** 一个词至少出现多少次才进词库（一次性的生僻词不算「常用语汇」）。 */
const MIN_COUNT = Number(arg("min-count", "3"));
/** 分类结果给站长核对的报告（CSV，Excel 能直接打开）。 */
const OUT = resolve(arg("out", "docs/f1/vocab-preview.csv"));
const AUTHOR_UIDS = editorAuthorUids();

const prisma = new PrismaClient();

/** 年份段：按茶的年份划。 */
function ageBracket(year) {
  if (year == null) return "any";
  if (year >= 2020) return "young";
  if (year >= 2010) return "mid";
  return "aged";
}

// 四维标签与站内共用一份（src/lib/cellar.ts）—— 维度改名不会让词库与界面脱节。
// 「通用」是本脚本额外加的第五个归类（不属于任何单一维度）。
const DIM_LABELS = { ...APP_DIM_LABELS, any: "通用" };

function esc(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function collect() {
  const notes = await prisma.tastingNote.findMany({
    where: {
      source: { not: "article" },
      author: { uid: { in: AUTHOR_UIDS } },
    },
    select: {
      descriptors: true,
      tea: { select: { type: true, year: true } },
    },
  });

  /**
   * tag → { total, cats: { raw: {count, brackets}, ripe: {count, brackets} } }
   *
   * **按生熟分开统计**：同一个词在生普与熟普里的年份分布常常完全不同
   * （比如「烟香」多见于老生普，「堆味」多见于新熟普）。年份段必须按
   * 生熟各算各的 —— 用合并后的分布会给其中一个生熟写上错的年份段。
   */
  const map = new Map();
  for (const n of notes) {
    const list = Array.isArray(n.descriptors)
      ? n.descriptors.filter((x) => typeof x === "string")
      : [];
    const cat = n.tea?.type === "ripe" ? "ripe" : "raw";
    const bracket = ageBracket(n.tea?.year);
    for (const raw of list) {
      const tag = raw.trim();
      if (!tag || tag.length > 20) continue;
      let e = map.get(tag);
      if (!e) {
        e = { total: 0, cats: { raw: { count: 0, brackets: {} }, ripe: { count: 0, brackets: {} } } };
        map.set(tag, e);
      }
      e.total++;
      const c = e.cats[cat];
      c.count++;
      c.brackets[bracket] = (c.brackets[bracket] ?? 0) + 1;
    }
  }

  const kept = [...map.entries()]
    .filter(([, e]) => e.total >= MIN_COUNT)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, LIMIT);

  return { totalNotes: notes.length, totalWords: map.size, kept };
}

/** 让模型把词按四维粗分类。 */
async function classify(tags) {
  const list = tags.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const prompt = `下面是普洱茶品鉴笔记里常用的描述词。请把每一个词归到以下**唯一一个**维度：

- aroma：香气（闻到的：香、韵、蜜香、花香、烟香…）
- flavor：滋味（喝到的：甜、涩、苦、鲜、醇厚、汤感…）
- waterPath：水路（入口到咽下的顺滑度、流动性、生津、回甘…）
- bodyFeel：体感（身体反应：气力、暖意、喉韵、饱腹…）
- any：跨多个维度、或明显不属于以上四类的词

规则：
- 只输出 JSON，格式为 {"分类": {"1": "aroma", "2": "flavor", ...}}
- 每个词必须且只能有一个维度
- 拿不准的给 "any"，不要硬塞

词语列表：
${list}`;

  const target = minimaxTarget();
  const result = await callLLM(target, prompt, {
    maxTokens: 4000,
    retries: 2,
    fallbacks: [glmTarget()],
    temperature: 0,
  });

  const obj = result.content;
  const map = obj?.分类 ?? obj?.classification ?? obj;
  const out = new Map();
  if (map && typeof map === "object") {
    for (const [k, v] of Object.entries(map)) {
      const idx = Number(k) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= tags.length) continue;
      if (typeof v !== "string" || !(v in DIM_LABELS)) continue;
      out.set(tags[idx], v);
    }
  }
  return { dims: out, source: result.source, model: result.model };
}

async function main() {
  console.log(`站长作者白名单：${AUTHOR_UIDS.join(", ")}`);
  const { totalNotes, totalWords, kept } = await collect();
  console.log(
    `扫描 ${totalNotes} 条笔记，累计 ${totalWords} 个不同词；` +
      `出现 ≥${MIN_COUNT} 次的取前 ${kept.length} 个`,
  );

  if (!kept.length) {
    console.log("没有够格的词，退出。");
    return;
  }

  const tags = kept.map(([t]) => t);
  console.log(`\n请求 LLM 分类（${tags.length} 个词）…`);
  let dims = new Map();
  let source = "（未分类）";
  try {
    const r = await classify(tags);
    dims = r.dims;
    source = `${r.source} / ${r.model}`;
  } catch (e) {
    console.error(`分类失败：${e instanceof Error ? e.message : String(e)}`);
    console.error("继续按「通用」落库 —— 站长可在后台手工改维度。");
  }
  console.log(`分类来源：${source}`);

  // 组装要落库的行：每个词 × 它出现过的生熟
  const rows = [];
  for (const [tag, e] of kept) {
    const dim = dims.get(tag) ?? "any";
    const cats = [];
    if (e.raw > 0) cats.push(["raw", e.raw]);
    if (e.ripe > 0) cats.push(["ripe", e.ripe]);
    for (const [cat] of cats) {
      // 年份段：该生熟下出现最多的那个；分布太散就归 any
      const brackets = Object.entries(e.brackets).sort((a, b) => b[1] - a[1]);
      const top = brackets[0];
      const total = brackets.reduce((s, [, v]) => s + v, 0);
      const age = top && top[1] / total >= 0.6 ? top[0] : "any";
      rows.push({
        tag,
        category: cat,
        ageBracket: age,
        dim,
        count: e.count,
        source: dims.has(tag) ? "llm" : "seed",
      });
    }
  }

  // 报告：给站长核对
  const csv = [
    ["词", "生熟", "年份段", "维度", "出现次数"].map(esc).join(","),
    ...rows.map((r) =>
      [r.tag, r.category, r.ageBracket, r.dim, r.count].map(esc).join(","),
    ),
  ].join("\n");
  // 目录可能不存在（服务器上 docs/f1/ 就没建）—— 自己建，别指望调用方先建。
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `﻿${csv}\n`, "utf8");
  console.log(`\n分类报告已写：${OUT}（给站长核对用）`);

  const byDim = {};
  for (const r of rows) byDim[r.dim] = (byDim[r.dim] ?? 0) + 1;
  console.log("维度分布：", byDim);

  if (!APPLY) {
    console.log("\n这是 dry-run。加 --apply 才写库。");
    return;
  }

  let written = 0;
  for (const r of rows) {
    await prisma.descriptorVocab.upsert({
      where: { tag_category: { tag: r.tag, category: r.category } },
      update: {
        ageBracket: r.ageBracket,
        dim: r.dim,
        source: r.source,
      },
      create: {
        tag: r.tag,
        category: r.category,
        ageBracket: r.ageBracket,
        dim: r.dim,
        source: r.source,
      },
    });
    written++;
  }
  console.log(`\n已写入 ${written} 条（upsert，重复跑不会产生重复行）。`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
