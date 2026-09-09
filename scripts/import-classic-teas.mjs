#!/usr/bin/env node

/**
 * import-classic-teas.mjs — 经典普洱模块初始化/刷新（P2-R2，幂等可重跑）
 *
 * 1) 标记经典茶：teas."isClassic" = true
 *    - 命中经典名单（7542/88青/大白菜/老班章…，name 或 aliases 正则匹配）
 *    - 或品鉴笔记数 >= --min-notes（默认 3）
 * 2) 建"经典普洱"版块（slug=classics，已存在则复用）
 * 3) 为每个经典茶自动建长期跟进帖（type=discussion, teaId 关联；
 *    已存在同茶跟进帖则跳过）→ 进入论坛热榜体系，可评论/灌水
 * 4) 可选：从东和 SKU 库(rag-data/sku-clean.jsonl)匹配行情快照，
 *    写入 teas."marketInfo" {price, changePct, updatedAt, source}
 *
 * Run (host-side, same env as cron-task.sh):
 *   DATABASE_URL=... node scripts/import-classic-teas.mjs [--min-notes=3] \
 *     [--sku-file=/opt/puer-hub/rag-data/sku-clean.jsonl] [--dry]
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { log, sql, sqlSingle, escapeSql } from "./lib/post-helpers.mjs";

// ── Args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};
const DRY = args.includes("--dry");
const MIN_NOTES = parseInt(flag("min-notes", "3"), 10);
const SKU_FILE = flag("sku-file", "/opt/puer-hub/rag-data/sku-clean.jsonl");

// 公认经典品种关键词（name/aliases 正则，大小写不敏感）
const CLASSIC_REGEX = [
  "7542", "7572", "8582", "8592", "8653", "8892", "7742",
  "88青", "大白菜", "紫大益", "玫瑰大益", "绿大树", "金大益", "乌金号",
  "勐海孔雀", "金色韵象", "洞天福地", "英雄骏马", "易昌",
  "老班章", "冰岛", "昔归", "薄荷塘", "弯弓", "天门山",
  "红印", "蓝印", "黄印", "水蓝印", "宋聘", "同庆", "福元昌", "车顺",
].join("|");

// ── Step 1: mark classic teas ───────────────────────────────────────
async function markClassics() {
  const q = `
    UPDATE teas SET "isClassic" = true
    WHERE "tastingNoteCount" >= ${MIN_NOTES}
       OR name ~* '(${CLASSIC_REGEX})'
       OR EXISTS (
         SELECT 1 FROM unnest(COALESCE(aliases, ARRAY[]::text[])) a
         WHERE a ~* '(${CLASSIC_REGEX})'
       )
    RETURNING id`;
  const rows = DRY ? await sqlSingle(`SELECT id FROM teas WHERE "tastingNoteCount" >= ${MIN_NOTES} OR name ~* '(${CLASSIC_REGEX})'`) : (await sql(q)).rows;
  log(`[1/4] isClassic 标记：${rows.length} 款${DRY ? "（dry，未写入）" : ""}`);
  return rows.map((r) => r.id);
}

// ── Step 2: ensure "classics" board ─────────────────────────────────
async function ensureBoard() {
  const existing = await sqlSingle(`SELECT id FROM boards WHERE slug = 'classics' LIMIT 1`);
  if (existing.length > 0) {
    log(`[2/4] 版块已存在：classics (${existing[0].id})`);
    return existing[0].id;
  }
  if (DRY) { log(`[2/4] dry：将创建版块 classics`); return null; }
  const id = randomUUID();
  await sql(`
    INSERT INTO boards (id, name, slug, description, icon, "sortOrder", "minKarma")
    VALUES ('${id}', '经典普洱', 'classics', '经典品种档案与转化跟进讨论', '🏵️', 65, 0)`);
  log(`[2/4] 已创建版块：经典普洱 (${id})`);
  return id;
}

// ── Step 3: follow-up discussion thread per classic tea ─────────────
async function pickAuthor() {
  const admin = await sqlSingle(`SELECT id FROM users WHERE role = 'admin' ORDER BY "createdAt" ASC LIMIT 1`);
  if (admin.length > 0) return admin[0].id;
  const any = await sqlSingle(`SELECT id FROM users WHERE "banStatus" = 'active' ORDER BY "createdAt" ASC LIMIT 1`);
  return any[0]?.id || null;
}

async function createFollowThreads(classicIds, boardId) {
  if (!boardId) { log(`[3/4] 跳过（无版块 id）`); return { created: 0, skipped: classicIds.length }; }
  const authorId = await pickAuthor();
  if (!authorId) { log(`[3/4] 无可用作者账号，跳过`); return { created: 0, skipped: classicIds.length }; }

  const teas = await sqlSingle(`
    SELECT id, name, brand, year, type, description, "tastingNoteCount"
    FROM teas WHERE "isClassic" = true ORDER BY "tastingNoteCount" DESC`);
  let created = 0, skipped = 0;
  for (const t of teas) {
    const exists = await sqlSingle(`
      SELECT id FROM articles
      WHERE "teaId" = '${t.id}' AND type = 'discussion' AND title LIKE '【经典普洱】%'
      LIMIT 1`);
    if (exists.length > 0) { skipped++; continue; }
    if (DRY) { created++; continue; }

    const typeLabel = t.type === "ripe" ? "熟茶" : "生茶";
    const title = `【经典普洱】${t.year || ""} ${escapeSql(t.brand)} ${escapeSql(t.name)} 跟进讨论帖`;
    const intro = (t.description || `${t.brand} ${t.name}，${t.year || ""}年${typeLabel}。`)
      .replace(/<[^>]*>/g, "").slice(0, 300);
    const content = [
      `<p><strong>${escapeSql(t.brand)} · ${escapeSql(t.name)}</strong>（${t.year || "年份待考"} · ${typeLabel}${t.tastingNoteCount > 0 ? ` · 已收录 ${t.tastingNoteCount} 篇品鉴` : ""}）</p>`,
      `<p>${escapeSql(intro)}</p>`,
      `<p>这里是这款茶的长期跟进帖，欢迎随时来"灌水"：</p>`,
      `<p>🍵 最近喝到的状态（香气/汤感/喉韵）<br/>📉 转化观察（对比上次有什么变化）<br/>💰 行情与流通见闻<br/>📸 开汤图随手发</p>`,
      `<p>完整品种档案与历年转化档案见<a href="/tea/${t.id}">茶品详情页</a>。</p>`,
    ].join("\n");
    const summary = `${t.brand} ${t.name} 长期跟进帖：品饮感受、转化观察、行情见闻。`;
    const aid = randomUUID();
    await sql(`
      INSERT INTO articles (id, type, title, content, summary, "boardId", "teaId",
        status, visibility, "authorId", flair, tags, "createdAt", "updatedAt", "lastRepliedAt")
      VALUES ('${aid}', 'discussion', '${escapeSql(title)}', '${escapeSql(content)}', '${escapeSql(summary)}',
        '${boardId}', '${t.id}', 'published', 'public', '${authorId}', NULL,
        ARRAY['经典普洱']::text[], NOW(), NOW(), NOW())`);
    await sql(`UPDATE boards SET "threadCount" = "threadCount" + 1, "postCount" = "postCount" + 1,
      "lastPostedAt" = NOW() WHERE id = '${boardId}'`);
    created++;
  }
  log(`[3/4] 跟进帖：新建 ${created}，已存在跳过 ${skipped}${DRY ? "（dry）" : ""}`);
  return { created, skipped };
}

// ── Step 4: Donghe market snapshot (best-effort) ────────────────────
function pickPrice(row) {
  // sku-clean.jsonl 字段防御性解析：价格可能出现在多个位置
  const candidates = [row.price, row.marketPrice, row.latestPrice, row.quote?.price, row.market?.price];
  for (const c of candidates) {
    if (typeof c === "number") return `${c.toLocaleString("zh-CN")} 元/${row.unit || "件"}`;
    if (typeof c === "string" && /[\d]/.test(c)) return `${c}${row.unit ? ` /${row.unit}` : ""}`;
  }
  return null;
}

async function applyMarket() {
  let lines;
  try { lines = readFileSync(SKU_FILE, "utf-8").split("\n").filter(Boolean); }
  catch { log(`[4/4] SKU 文件不存在（${SKU_FILE}），跳过行情`); return; }

  const teas = await sqlSingle(`SELECT id, name, brand FROM teas WHERE "isClassic" = true`);
  let matched = 0;
  for (const line of lines) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const skuName = row.name || row.skuName || row.productName || row.title;
    if (!skuName || typeof skuName !== "string" || skuName.length < 3) continue;
    const price = pickPrice(row);
    if (!price) continue;
    // 匹配：SKU 名与茶名互相包含（品牌+品名优先）
    const hit = teas.find(
      (t) =>
        (t.name.length >= 3 && skuName.includes(t.name)) ||
        (skuName.length >= 4 && t.name.includes(skuName)) ||
        (t.brand && skuName.includes(t.brand) && t.name.length >= 2 && skuName.includes(t.name.slice(-4))),
    );
    if (!hit) continue;
    const info = {
      skuId: row.skuId || row.id || null,
      name: skuName.slice(0, 120),
      price,
      changePct: typeof row.changePct === "number" ? row.changePct : (typeof row.change === "number" ? row.change : undefined),
      updatedAt: row.updatedAt || row.updateTime || new Date().toISOString().slice(0, 10),
      source: "东和",
    };
    if (DRY) { matched++; continue; }
    await sql(`UPDATE teas SET "marketInfo" = '${escapeSql(JSON.stringify(info))}'::jsonb WHERE id = '${hit.id}'`);
    matched++;
  }
  log(`[4/4] 行情快照：匹配 ${matched} 款（SKU 库 ${lines.length} 条）${DRY ? "（dry）" : ""}`);
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  log(`import-classic-teas 开始 min-notes=${MIN_NOTES} sku-file=${SKU_FILE}${DRY ? " [DRY]" : ""}`);
  const classicIds = await markClassics();
  const boardId = await ensureBoard();
  await createFollowThreads(classicIds, boardId);
  await applyMarket();
  const total = await sqlSingle(`SELECT COUNT(*)::int AS n FROM teas WHERE "isClassic" = true`);
  log(`完成：经典茶 ${total[0].n} 款（/forum/classics 可见）`);
}

main().catch((e) => { console.error(e); process.exit(1); });

