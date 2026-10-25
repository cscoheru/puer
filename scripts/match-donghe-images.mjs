#!/usr/bin/env node
/**
 * match-donghe-images.mjs —— 给**没图**的茶品配东和茶图。
 *
 * ## 背景
 *
 * 站长 2026-10-25：「从东和行情中导入的茶品库茶品中，基本都是不带图片的吗，
 * 东和的茶品本来都是茶图对应的，你看下 rag 库中能不能对应，**一定要准确**，
 * 如果对应不了就先不动。」
 *
 * 事实（2026-10-25 实测）：
 *   - 库里 2323 款茶，只有 161 款有图 —— 「基本都不带图」属实。
 *   - 东和 SKU 清单（rag-data/donghe-skus.jsonl，6717 条）**每条都有**
 *     `img`（茶图）与 `year` ✅。
 *   - 导入脚本当年就是靠「归一化后**完全同名**」去 SKU 找图的
 *     （`skuByName`）—— 所以有图的那 161 款就是当年对上的，剩下的对不上。
 *
 * ## 本脚本怎么判「同一款」
 *
 * 三条依据同时成立才算（规则在 src/lib/tea-product-match.ts，与导入脚本共用
 * **同一份**判定，不会两处漂）：
 *   1. **年份一致**（东和 SKU 有 year 字段）；
 *   2. **核心词包含度** ≥ 阈值（名字长短不一时包含度比相似度准）；
 *   3. **批次不冲突**（「204紫大益7572」与「208紫大益7572」不是同一款）。
 *
 * 分三档：
 *   A. 归一化后**完全同名** + 年份一致      → 可直接写
 *   B. 同年 + 包含度 ≥ 0.9 + 无批次冲突      → 高可信，可写（默认档）
 *   C. 同年 + 包含度 ≥ 0.8                  → **只报告，不写**（让站长看）
 *
 * ## 安全
 *
 * - **默认 dry-run**：只出报告，一个字都不写。
 * - `--apply` 才写；`--min-score` 控制写哪一档（默认 0.9 = A+B）。
 * - 只填**空着的** coverImage / gallery（不覆盖已有的图）。
 * - 裸 pg + 参数化 SQL（不依赖镜像内的 Prisma Client 版本）。
 *
 * Run:
 *   node --import tsx scripts/match-donghe-images.mjs            # dry-run 报告
 *   node --import tsx scripts/match-donghe-images.mjs --apply    # 写 A+B 档
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";

import {
  batchOf,
  bigrams,
  containment,
  coreOf,
  MIN_CORE_CHARS,
} from "../src/lib/tea-product-match.ts";
import { normalizeTeaName } from "../src/lib/tea-name-normalize.ts";

const APPLY = process.argv.includes("--apply");
const MIN_SCORE = Number(
  (process.argv.find((a) => a.startsWith("--min-score=")) || "").split("=")[1] || 0.9,
);
const RAG = process.env.RAG_DATA_DIR || "/opt/puer-hub/rag-data";
const SKU_FILE = `${RAG}/donghe-skus.jsonl`;
/** 东和茶图在服务器上的本地副本（rag-data/donghe-images/<skuId>.jpeg）。 */
const IMG_DIR = `${RAG}/donghe-images`;
/** 站内茶图目录（nginx 的 /uploads/tea/ 别名指向这里）。 */
const UPLOAD_DIR = process.env.TEA_UPLOAD_DIR || "/opt/puer-hub/uploads/tea";
/** 站内路径前缀。 */
const UPLOAD_PREFIX = "/uploads/tea";

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** 读东和 SKU 清单，按年份分桶。 */
function loadSkus() {
  const lines = readFileSync(SKU_FILE, "utf8").split("\n").filter(Boolean);
  const byYear = new Map();
  let withImg = 0;
  for (const line of lines) {
    let s;
    try {
      s = JSON.parse(line);
    } catch {
      continue;
    }
    if (!s?.img || !s?.name) continue;
    withImg++;
    const year = Number(s.year) || 0;
    const list = byYear.get(year) ?? [];
    list.push({
      skuId: s.skuId,
      name: String(s.name),
      img: s.img,
      year,
      core: coreOf(s.name),
      batch: batchOf(s.name),
    });
    byYear.set(year, list);
  }
  // 核心太短的（认不出产品身份）不参与匹配
  for (const [year, list] of byYear) {
    byYear.set(
      year,
      list.filter((s) => s.core.length >= MIN_CORE_CHARS),
    );
  }
  log(`东和 SKU：${lines.length} 条，其中 ${withImg} 条带图，按年份分桶 ${byYear.size} 组`);
  return byYear;
}

/** 库里没图的茶品。 */
const TEAS_SQL = `
  SELECT id, name, year, brand, "coverImage", gallery, "marketInfo" ->> 'skuId' AS sku_id
    FROM teas
   WHERE "deletedAt" IS NULL
     AND ("coverImage" IS NULL OR "coverImage" = '')
     AND (gallery IS NULL OR gallery = '[]'::jsonb)
   ORDER BY year, name
`;

/**
 * 写图（只填空着的）。
 *
 * ⚠️ **只写封面，不写 gallery**（站长 2026-10-26 定的）：东和茶图只是
 * 「本来没图时的封面」，不是茶品图集 —— 把它塞进 gallery 会让茶品页的
 * 图片墙看起来像是有多张图，其实只有一张东和图。
 */
const FILL_SQL = `
  UPDATE teas
     SET "coverImage" = $2
   WHERE id = $1
     AND ("coverImage" IS NULL OR "coverImage" = '')
`;

/**
 * 清理：把「封面是东和图、且 gallery 里只有这一张」的图集清空。
 *
 * 2026-10-25 的第一版脚本顺手把东和图也写进了 gallery —— 站长 2026-10-26
 * 指出「东和图片仅作为封面」，这个模式把那次写的图集撤掉。
 * 只动「gallery 恰好只有封面这一张」的（= 当初被脚本写进去的）✅，
 * 真正的多图图集（本地图）不受影响 ✅。
 */
const CLEAR_GALLERY_SQL = `
  UPDATE teas
     SET gallery = NULL
   WHERE "coverImage" LIKE '%/donghe-%'
     AND gallery IS NOT NULL
     AND gallery = to_jsonb(ARRAY["coverImage"]::text[])
`;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: missing required env DATABASE_URL.");
    process.exit(1);
  }
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // 清理模式：把「东和图进了图集」的撤回（站长 2026-10-26 的要求）
    if (process.argv.includes("--clear-gallery")) {
      const cleared = await client.query(CLEAR_GALLERY_SQL);
      log(`已撤回 ${cleared.rowCount} 个图集里的东和图（东和图只做封面）`);
      log("=== Done: status=ok ===");
      return;
    }

    const skusByYear = loadSkus();
    const { rows: teas } = await client.query(TEAS_SQL);
    log(`没图的茶品：${teas.length} 款`);

    const tierA = [];
    const tierB = [];
    const tierC = [];
    const unmatched = [];

    for (const t of teas) {
      const core = coreOf(t.name);
      if (core.length < MIN_CORE_CHARS) {
        unmatched.push({ ...t, reason: "核心词太短，认不出产品身份" });
        continue;
      }
      const myBatch = batchOf(t.name);
      const myBg = bigrams(core);

      // 年份桶：同年的 SKU + 年份未知的 SKU
      const candidates = [
        ...(skusByYear.get(t.year) ?? []),
        ...(skusByYear.get(0) ?? []),
      ];
      if (candidates.length === 0) {
        unmatched.push({ ...t, reason: `东和没有 ${t.year} 年的 SKU` });
        continue;
      }

      let best = null;
      for (const s of candidates) {
        // 批次冲突 → 不是同一款
        if (myBatch && s.batch && myBatch !== s.batch) continue;
        const score = containment(myBg, bigrams(s.core));
        if (score <= 0) continue;
        if (!best || score > best.score) best = { ...s, score };
      }

      if (!best) {
        unmatched.push({ ...t, reason: "没有可配的候选" });
        continue;
      }
      const exact =
        normalizeTeaName(t.name) === normalizeTeaName(best.name) &&
        (best.year === 0 || best.year === t.year);

      const row = {
        id: t.id,
        name: t.name,
        year: t.year,
        brand: t.brand,
        skuId: best.skuId,
        skuName: best.name,
        skuYear: best.year,
        img: best.img,
        score: Math.round(best.score * 100) / 100,
      };
      if (exact) tierA.push(row);
      else if (best.score >= 0.9) tierB.push(row);
      else if (best.score >= 0.8) tierC.push(row);
      else unmatched.push({ ...t, reason: `最高只到 ${row.score}` });
    }

    const write = APPLY ? [...tierA, ...tierB].filter((r) => r.score >= MIN_SCORE) : [];
    let written = 0;
    let copied = 0;
    let noLocalFile = 0;
    for (const r of write) {
      // 茶图**落到站内**（不是外链东和的 OSS —— 那是对方的测试桶，
      // 外链随时会挂）。服务器上有东和茶图的本地副本：donghe-images/<skuId>.jpeg。
      const src = `${IMG_DIR}/${r.skuId}.jpeg`;
      const fileName = `donghe-${r.skuId}.jpeg`;
      const dest = `${UPLOAD_DIR}/${fileName}`;
      if (!existsSync(src)) {
        noLocalFile++;
        continue;
      }
      if (!existsSync(dest)) {
        copyFileSync(src, dest);
        copied++;
      }
      const url = `${UPLOAD_PREFIX}/${fileName}`;
      const res = await client.query(FILL_SQL, [r.id, url]);
      written += res.rowCount;
    }

    log(
      `mode=${APPLY ? "apply" : "dry-run"} ` +
        `A(完全同名)=${tierA.length} B(≥0.9)=${tierB.length} ` +
        `C(≥0.8 只报告)=${tierC.length} 未匹配=${unmatched.length} ` +
        `写入=${written} 复制图片=${copied}${noLocalFile ? ` 缺本地图=${noLocalFile}` : ""}`,
    );
    const show = (label, rows) => {
      if (!rows.length) return;
      log(`--- ${label}（前 10 条）---`);
      for (const r of rows.slice(0, 10)) {
        log(
          `  ${r.name} (${r.year} ${r.brand})  →  SKU ${r.skuId}「${r.skuName}」` +
            `  包含度=${r.score}  ${r.img}`,
        );
      }
    };
    show("A 完全同名", tierA);
    show("B 高可信（≥0.9）", tierB);
    show("C 待人工确认（≥0.8）", tierC);
    log("=== Done ===");
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
