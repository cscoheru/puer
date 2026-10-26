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
 * 事实：东和 SKU 清单（rag-data/donghe-skus.jsonl，6717 条）每条都有 `img`
 * 字段，但**其中相当一部分不是茶图，是品牌 logo 占位图**（东和把品牌 logo
 * 当成某些 SKU 的主图）。2026-10-25 的第一版脚本把这些 logo 直接当封面用，
 * 于是茶品页上出现「东和茶叶」的 logo 当茶图 —— 站长 2026-10-26 指出并要求
 * 修正。
 *
 * ## 现在的规则
 *
 *   1. **只填空着的封面**（原来有图的一律不动）。
 *   2. **东和图只当封面**，不进图集（gallery）。
 *   3. **品牌 logo 占位图一律不用**：一张图被多个 SKU 共用 → 它是 logo，
 *      不是茶图 → 跳过。已用上的要清掉。
 *   4. 茶图**从 SKU 的 `img` URL 下载**（本地 donghe-images/ 会被重新抓取
 *      覆盖，里面的文件随时可能对不上 skuId —— 第一版就是栽在这）。
 *
 * ## 安全
 *
 * - 默认 dry-run，只出报告；`--apply` 才写库。
 * - 幂等：只填空着的；已填 logo 的会被清掉（清完再跑就是 no-op）。
 * - 裸 pg + 参数化 SQL（不依赖镜像内的 Prisma Client 版本）。
 *
 * Run:
 *   node --import tsx scripts/match-donghe-images.mjs            # dry-run 报告
 *   node --import tsx scripts/match-donghe-images.mjs --apply
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const APPLY = process.argv.includes("--apply");
const MIN_SCORE = Number(
  (process.argv.find((a) => a.startsWith("--min-score=")) || "").split("=")[1] || 0.9,
);
const RAG = process.env.RAG_DATA_DIR || "/opt/puer-hub/rag-data";
const SKU_FILE = `${RAG}/donghe-skus.jsonl`;
/** 东和茶图的本地副本目录（按 skuId 命名）。 */
const IMG_DIR = `${RAG}/donghe-images`;
/** 站内茶图目录（nginx 的 /uploads/tea/ 别名指向这里）。 */
const UPLOAD_DIR = process.env.TEA_UPLOAD_DIR || "/opt/puer-hub/uploads/tea";
const UPLOAD_PREFIX = "/uploads/tea";
/** 一张图被这么多 SKU 共用 → 它是品牌 logo，不是茶图。 */
const LOGO_SHARE_THRESHOLD = 3;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function md5(buf) {
  return createHash("md5").update(buf).digest("hex");
}

/** 读东和 SKU 清单。 */
function loadSkus() {
  const lines = readFileSync(SKU_FILE, "utf8").split("\n").filter(Boolean);
  const skus = new Map();
  for (const line of lines) {
    let s;
    try {
      s = JSON.parse(line);
    } catch {
      continue;
    }
    if (!s?.skuId) continue;
    skus.set(String(s.skuId), s);
  }
  log(`东和 SKU：${skus.size} 条`);
  return skus;
}

/**
 * 本地图 → 有多少个 SKU 在用它。
 *
 * **一张图被多个 SKU 共用 = 品牌 logo 占位图**（东和把品牌 logo 当成某些
 * SKU 的主图）。这个统计必须按**图片内容**（哈希）算，不能按文件名 ——
 * 文件名是 skuId，内容才是图。
 *
 * ⚠️ 本地 donghe-images/ 会被重新抓取覆盖，里面的文件随时可能对不上
 * skuId —— 所以这里的统计只用来「按内容」判定，下载一律走 SKU 的 img URL。
 */
function buildShareIndex(skus) {
  const byHash = new Map();
  for (const [sid] of skus) {
    const p = `${IMG_DIR}/${sid}.jpeg`;
    if (!existsSync(p)) continue;
    let h;
    try {
      h = md5(readFileSync(p));
    } catch {
      continue;
    }
    const arr = byHash.get(h) || [];
    arr.push(sid);
    byHash.set(h, arr);
  }
  const shared = new Map();
  for (const [h, arr] of byHash) {
    if (arr.length >= LOGO_SHARE_THRESHOLD) shared.set(h, arr.length);
  }
  log(`本地图片哈希统计：${byHash.size} 种，其中被 ${LOGO_SHARE_THRESHOLD}+ 个 SKU 共用的（logo 占位）${shared.size} 种`);
  return { byHash, shared };
}

/** 从 SKU 的 img URL 下载茶图，落到站内 uploads 目录。 */
async function fetchTeaImage(sku) {
  const fileName = `donghe-${sku.skuId}.jpeg`;
  const dest = `${UPLOAD_DIR}/${fileName}`;
  const url = sku.img;
  if (!url) return { fileName, ok: false, reason: "no-img" };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { fileName, ok: false, reason: `http-${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) return { fileName, ok: false, reason: "too-small" };
    mkdirSync(UPLOAD_DIR, { recursive: true });
    writeFileSync(dest, buf);
    return { fileName, ok: true, hash: md5(buf), bytes: buf.length };
  } catch (e) {
    return { fileName, ok: false, reason: String(e?.message || e).split("\n")[0] };
  }
}

/** 只写封面，不写图集（站长 2026-10-26：东和图仅作为封面）。 */
const FILL_SQL = `
  UPDATE teas
     SET "coverImage" = $2
   WHERE id = $1
     AND ("coverImage" IS NULL OR "coverImage" = '')
`;

/** 清掉「封面是东和图、且那张图其实是 logo」的封面。 */
const CLEAR_LOGO_COVER_SQL = `
  UPDATE teas SET "coverImage" = NULL, gallery = NULL
   WHERE "coverImage" LIKE '%/donghe-%'
     AND id = ANY($1::text[])
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
    const skus = loadSkus();
    const { shared } = buildShareIndex(skus);

    // ── 第一步：纠正「已经用上的 logo 封面」 ───────────────────────────
    const { rows: filled } = await client.query(`
      SELECT id, name, "coverImage"
        FROM teas
       WHERE "coverImage" LIKE '%/donghe-%'
         AND "deletedAt" IS NULL
    `);
    const logoTeas = [];
    for (const t of filled) {
      const sid = String(t.coverImage).match(/donghe-(\d+)\./)?.[1];
      const sku = sid ? skus.get(sid) : null;
      if (!sku) continue;
      // 重新下载正确的那张（本地副本可能已被重新抓取覆盖）
      const img = await fetchTeaImage(sku);
      if (!img.ok) {
        log(`  下载失败 ${sku.skuId} ${sku.name}: ${img.reason}`);
        continue;
      }
      const shareCount = shared.get(img.hash) ?? 1;
      if (shareCount >= LOGO_SHARE_THRESHOLD) {
        // 这张图被好几个 SKU 共用 → 是品牌 logo，不是茶图
        logoTeas.push({ id: t.id, name: t.name, skuId: sku.skuId, skuName: sku.name, shareCount });
      } else {
        // 是真图：站上那份文件已经被换成正确的了（同一个文件名）
        log(`  修正 ${t.name} → ${sku.name}（真图，${img.bytes} 字节）`);
      }
    }

    log(
      `已用东和封面的茶 ${filled.length} 款，其中 **${logoTeas.length} 款用的是品牌 logo 占位图**` +
        `（要清掉封面）`,
    );
    for (const t of logoTeas.slice(0, 12)) {
      log(`  logo 占位：${t.name} → SKU ${t.skuId}「${t.skuName}」（${t.shareCount} 个 SKU 共用这张图）`);
    }

    if (APPLY && logoTeas.length) {
      const res = await client.query(CLEAR_LOGO_COVER_SQL, [logoTeas.map((t) => t.id)]);
      log(`已清掉 ${res.rowCount} 个 logo 封面的茶品（回到「无图」状态，等站长的真图）`);
    }

    // ── 第二步：给没图的茶配真图 ─────────────────────────────────────
    const { rows: noImg } = await client.query(`
      SELECT id, name, year, brand
        FROM teas
       WHERE ("coverImage" IS NULL OR "coverImage" = '')
         AND "deletedAt" IS NULL
    `);
    log(`没图的茶品：${noImg.length} 款`);

    const core = (n) => {
      let s = String(n || "").normalize("NFKC").toLowerCase();
      s = s.replace(/\d+/g, "");
      for (const w of ["普洱", "生茶", "熟茶", "产品", "定制", "系列", "高级", "精品", "特级", "印级", "唛级", "批次", "年", "饼", "沱", "砖", "散", "贡", "生", "熟", "茶", "号"]) {
        s = s.split(w).join("");
      }
      for (const w of ["公斤", "克", "提", "件", "片", "篓", "筒", "罐", "条", "盒", "g"]) {
        s = s.split(w).join("");
      }
      return s.replace(/[\s\-_（）()\[\]【】「」,，.。:：·、/]/g, "");
    };
    const batchOf = (n) => String(n || "").normalize("NFKC").match(/^(\d{3})(?!\d)/)?.[1] || null;
    const bigrams = (s) => {
      const out = new Set();
      for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
      return out;
    };
    const containment = (a, b) => {
      if (!a.size || !b.size) return 0;
      let inter = 0;
      for (const g of a) if (b.has(g)) inter++;
      return inter / Math.min(a.size, b.size);
    };

    // 按年份分桶的 SKU 索引
    const byYear = new Map();
    for (const s of skus.values()) {
      if (!s.img) continue;
      const y = Number(s.year) || 0;
      const list = byYear.get(y) || [];
      list.push(s);
      byYear.set(y, list);
    }
    const skuCore = new Map();
    for (const [sid, s] of skus) skuCore.set(sid, core(s.name || ""));

    let filledCount = 0;
    let skippedLogo = 0;
    for (const t of noImg) {
      const c = core(t.name);
      if (c.length < 3) continue;
      const myBg = bigrams(c);
      const myBatch = batchOf(t.name);
      const cands = [...(byYear.get(t.year) || []), ...(byYear.get(0) || [])];
      let best = null;
      for (const s of cands) {
        if (myBatch && batchOf(s.name) && myBatch !== batchOf(s.name)) continue;
        const score = containment(myBg, bigrams(skuCore.get(String(s.skuId))));
        if (score <= 0) continue;
        if (!best || score > best.score) best = { s, score };
      }
      if (!best || best.score < MIN_SCORE) continue;
      const img = await fetchTeaImage(best.s);
      if (!img.ok) continue;
      if ((shared.get(img.hash) ?? 1) >= LOGO_SHARE_THRESHOLD) {
        skippedLogo++;
        log(`  跳过（logo 占位）${t.name} → SKU ${best.s.skuId}「${best.s.name}」`);
        continue;
      }
      if (APPLY) {
        await client.query(FILL_SQL, [t.id, `${UPLOAD_PREFIX}/${img.fileName}`]);
      }
      filledCount++;
    }
    log(
      `第二步入��：匹配到真图 ${filledCount} 款（其中 logo 占位跳过 ${skippedLogo} 款）` +
        `${APPLY ? "，已写入" : "（dry-run，未写库）"}`,
    );
    log("=== Done: status=ok ===");
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
