#!/usr/bin/env node

/**
 * f1-make-eval-set.mjs — 生成 F1 评测集的标注底稿。
 *
 * PRD v0.3 §5 Phase 1：批量回填前必须先由站长手工标注 50–100 条，
 * 抽取一致率（stage / delta）达到 85% 才允许批量写入。
 *
 * 这个脚本只做两件事：
 *   1. 分层抽样（按年份，保证每年都有样本）出 N 条站长原始笔记；
 *   2. 产出两份文件：
 *        docs/f1/eval-set.jsonl  机器用（id + 原文）
 *        docs/f1/eval-set.tsv    人用（Excel/Numbers 直接打开填最后 5 列）
 *
 * 标注约定（写进 TSV 表头，避免歧义）：
 *   最后五列留空 = 还没标（评测时跳过）
 *   填 `-`      = 原文未提及（评测时应抽成 null；模型抽出了就是误报）
 *   填实值      = 期望值
 *
 * Dry-run by default? 不需要写库，直接生成文件。--out 可改目录。
 *
 * Run:
 *   node --import tsx scripts/f1-make-eval-set.mjs
 *   node --import tsx scripts/f1-make-eval-set.mjs --n 80 --author-uid 1001
 */

import { PrismaClient } from "../src/generated/prisma/client.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const N = Number(arg("n", "100"));
const AUTHOR_UID = Number(arg("author-uid", "1001"));
const MIN_CONTENT = Number(arg("min-content", "80"));
const OUT_DIR = resolve(arg("out", "docs/f1"));

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function oneLine(s, max) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function tsvCell(s) {
  return String(s ?? "").replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

/** 按年份分层抽样：每年按比例分配，至少 3 条（该年不足则全取）。 */
function stratifiedSample(rows, n) {
  const byYear = new Map();
  for (const r of rows) {
    const y = new Date(r.createdAt).getUTCFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(r);
  }
  const years = [...byYear.keys()].sort();
  const total = rows.length;
  const picked = [];
  const quotas = new Map();

  let assigned = 0;
  for (const y of years) {
    const size = byYear.get(y).length;
    const q = Math.max(Math.min(3, size), Math.round((size / total) * n));
    quotas.set(y, q);
    assigned += q;
  }
  // 配额溢出时按年份样本量裁剪，不足时补到样本最多的年份
  let overflow = assigned - n;
  for (const y of [...years].reverse()) {
    if (overflow <= 0) break;
    const q = quotas.get(y);
    const reducible = Math.min(overflow, Math.max(0, q - Math.min(3, byYear.get(y).length)));
    quotas.set(y, q - reducible);
    overflow -= reducible;
  }
  let deficit = n - [...quotas.values()].reduce((a, b) => a + b, 0);
  if (deficit > 0) {
    const biggest = years.sort((a, b) => byYear.get(b).length - byYear.get(a).length)[0];
    const room = byYear.get(biggest).length - quotas.get(biggest);
    const add = Math.min(deficit, Math.max(0, room));
    quotas.set(biggest, quotas.get(biggest) + add);
    deficit -= add;
  }

  for (const y of years) {
    const pool = byYear.get(y).slice();
    // 按时间均匀取，避免全是最新或最旧的
    const q = Math.min(quotas.get(y), pool.length);
    const step = pool.length / Math.max(1, q);
    for (let i = 0; i < q; i++) {
      picked.push(pool[Math.floor(i * step)]);
    }
  }
  return picked.slice(0, n);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: missing DATABASE_URL");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const author = await prisma.user.findFirst({
      where: { uid: AUTHOR_UID },
      select: { id: true, uid: true, username: true, nickname: true },
    });
    if (!author) {
      console.error(`ERROR: uid=${AUTHOR_UID} 不存在`);
      process.exit(1);
    }
    log(`作者：uid=${author.uid} ${author.nickname || author.username}`);

    const rows = await prisma.tastingNote.findMany({
      where: {
        authorId: author.id,
        // source='article' 是 AI/帖子镜像，不是站长原始笔记（PRD 明确排除）
        source: { not: "article" },
      },
      select: {
        id: true,
        title: true,
        content: true,
        createdAt: true,
        tea: { select: { name: true, year: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    log(`候选笔记：${rows.length} 条（source≠article）`);

    const usable = rows.filter((r) => (r.content || "").trim().length >= MIN_CONTENT);
    log(`正文 ≥${MIN_CONTENT} 字：${usable.length} 条`);

    if (usable.length < 10) {
      console.error("ERROR: 可用样本太少，无法构成评测集");
      process.exit(1);
    }

    const sample = stratifiedSample(usable, Math.min(N, usable.length));

    mkdirSync(OUT_DIR, { recursive: true });

    // ── 机器用 JSONL ─────────────────────────────────────────────
    const jsonl = sample
      .map((r) =>
        JSON.stringify({
          id: r.id,
          title: r.title,
          content: r.content,
          teaName: r.tea?.name ?? null,
          teaYear: r.tea?.year ?? null,
          createdAt: r.createdAt,
        }),
      )
      .join("\n");
    writeFileSync(resolve(OUT_DIR, "eval-set.jsonl"), `${jsonl}\n`, "utf8");

    // ── 人用 TSV ─────────────────────────────────────────────────
    const header = [
      "id",
      "日期",
      "茶品",
      "标题",
      "正文摘要",
      "stage",
      "delta",
      "grams",
      "vessel",
      "descriptors",
    ].join("\t");
    const lines = sample.map((r) =>
      [
        r.id,
        new Date(r.createdAt).toISOString().slice(0, 10),
        oneLine(`${r.tea?.name ?? ""} ${r.createdAt ? "" : ""}`, 24),
        oneLine(r.title, 40),
        oneLine(r.content, 180),
        "", // stage   上升期|巅峰期|适饮期|走下坡|-（未提及）
        "", // delta   更好|差不多|更差|-（未提及/首次品鉴）
        "", // grams   数字（克）|-
        "", // vessel  器具|-
        "", // descriptors 逗号分隔|-
      ]
        .map(tsvCell)
        .join("\t"),
    );
    writeFileSync(
      resolve(OUT_DIR, "eval-set.tsv"),
      `${header}\n${lines.join("\n")}\n`,
      "utf8",
    );

    log(`已生成 ${sample.length} 条：`);
    log(`  ${resolve(OUT_DIR, "eval-set.jsonl")}`);
    log(`  ${resolve(OUT_DIR, "eval-set.tsv")}`);
    log("");
    log("标注方法：用 Excel/Numbers 打开 .tsv，只填最后 5 列。");
    log("  留空 = 未标注（评测跳过）；填 - = 原文未提及（应抽成 null）。");
    log("  stage:   上升期 | 巅峰期 | 适饮期 | 走下坡 | -");
    log("  delta:   更好 | 差不多 | 更差 | -");
    log("  grams:   数字（克）| -");
    log("  vessel:  盖碗 | 紫砂壶 | … | -");
    log("  descriptors: 逗号分隔，必须是原文用词 | -");
    log("");
    log("标完后跑：node --import tsx scripts/f1-eval.mjs");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
