/**
 * rag-post.mjs — RAG-grounded draft generator (R28).
 *
 * 每日从「茶问」同一份 RAG 语料 (rag-data/knowledge-chunks.jsonl, 973 条真实
 * 公众号茶文) 选一篇未用过的素材 → 随机活跃老用户主笔 → MiniMax M3 人设化
 * 改写成论坛帖 → 硬校验 → 写入 status='draft' 草稿,进 /admin/drafts 后台
 * 人工审核后才发布。绝不直接发布。
 *
 * 防盲目创作五道闸:
 *   1. 幂等: content 埋 <!--rag-post:{srcHash}--> marker,同一篇素材永不复用;
 *   2. 接地: prompt 附素材原文,要求只基于素材展开,不虚构年份/价格/数字;
 *   3. 校验: 标题 10-40 字、正文(strip HTML)150-1000 字、禁 <img>、禁 AI 自曝;
 *   4. 日上限: RAG_POST_DAILY_CAP (默认 2),当日已有足够 rag 草稿则跳过;
 *   5. fail-safe: 单篇任何失败(检索/生成/校验/写库)只跳过不写半成品。
 *
 * Environment:
 *   DATABASE_URL        — PostgreSQL connection (cron-task.sh 提供)
 *   MINIMAX_API_KEY     — MiniMax key (cron-task.sh 提供)
 *   RAG_CHUNKS_FILE     — knowledge-chunks.jsonl 路径 (默认 /opt/puer-hub/rag-data/knowledge-chunks.jsonl)
 *   RAG_POST_DAILY_CAP  — 每日草稿上限 (默认 2)
 *   DRY_RUN=1           — 只生成打印,不写库(验收用)
 *
 * Run (host crontab): node scripts/rag-post.mjs
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import {
  MINIMAX_API_KEY, BOARDS, sql, sqlSingle, log, pickRandom, escapeSql,
} from "./lib/post-helpers.mjs";

const MINIMAX_BASE = "https://api.minimax.cn/v1/chat/completions";
const MINIMAX_MODEL = "MiniMax-M3";
const CHUNKS_FILE = process.env.RAG_CHUNKS_FILE || "/opt/puer-hub/rag-data/knowledge-chunks.jsonl";
const SKUS_FILE = process.env.RAG_SKUS_FILE || "/opt/puer-hub/rag-data/donghe-skus.jsonl";
const SKU_IMG_DIR = process.env.RAG_SKU_IMG_DIR || "/opt/puer-hub/rag-data/donghe-images";
const FORUM_IMG_DIR = process.env.FORUM_IMG_DIR || "/opt/puer-hub/uploads/forum";
const DAILY_CAP = Number(process.env.RAG_POST_DAILY_CAP || 2);
const DRY_RUN = process.env.DRY_RUN === "1";

// 主笔人设(与 auto-reply PERSONAS 呼应,偏发帖的口吻)
const PERSONAS = [
  { style: "喝了十来年普洱的老茶客", tone: "沉稳内行,爱聊仓储转化" },
  { style: "勤做笔记的发烧友", tone: "细致较真,数据口感都记" },
  { style: "喜欢淘老茶的收藏家", tone: "见多识广,带点故事感" },
  { style: "白天离不开茶的上班族", tone: "轻松日常,把茶当生活" },
  { style: "爱分享的茶会常客", tone: "热情健谈,爱抛话题" },
];

// ── helpers ──────────────────────────────────────────────────────────

function srcHash(source) {
  return createHash("md5").update(String(source)).digest("hex").slice(0, 12);
}

function boardFor(text) {
  const t = text || "";
  if (/仓储|存茶|转化|干仓|湿仓|发酵|工艺|杀青|历史|号级|印级/.test(t)) {
    return BOARDS.find((b) => b.slug === "knowledge") || BOARDS[0];
  }
  return BOARDS.find((b) => b.slug === "puer") || BOARDS[0];
}

async function loadChunks() {
  const lines = readFileSync(CHUNKS_FILE, "utf8").split("\n").filter(Boolean);
  const chunks = [];
  for (const line of lines) {
    try {
      const c = JSON.parse(line);
      if (c && c.source && c.text && c.text.length >= 400) chunks.push(c);
    } catch { /* malformed line — skip */ }
  }
  return chunks;
}

async function usedHashes() {
  const rows = await sqlSingle(
    `SELECT content FROM articles WHERE content LIKE '%<!--rag-post:%'`
  );
  const used = new Set();
  for (const r of rows) {
    const m = (r.content || "").match(/<!--rag-post:([a-f0-9]{12})-->/);
    if (m) used.add(m[1]);
  }
  return used;
}

async function countTodayDrafts() {
  const rows = await sqlSingle(
    `SELECT count(*)::int AS n FROM articles
     WHERE content LIKE '%<!--rag-post:%' AND "createdAt" >= CURRENT_DATE`
  );
  return rows[0]?.n || 0;
}

async function pickAuthor(excludeIds) {
  const excl = excludeIds.length
    ? `AND id NOT IN (${excludeIds.map((id) => `'${id}'`).join(",")})`
    : "";
  const rows = await sqlSingle(`
    SELECT id, username FROM users
    WHERE level >= 1 AND "banStatus" = 'active'
      AND "createdAt" < '2026-05-23'
      ${excl}
    ORDER BY RANDOM() LIMIT 3
  `);
  return rows[0] || null;
}

async function generateDraft(chunk, persona) {
  const material = String(chunk.text).slice(0, 1500);
  const prompt = `你是一个普洱茶社区的资深用户,人设是"${persona.style}",说话风格:${persona.tone}。
下面是你读到过的一篇真实茶文素材(来自公众号)。请以你的人设,把它消化后写成一篇你自己的论坛帖子。

【素材原文(仅供你参考消化,不要照抄大段原文)】
${material}

要求:
1. 标题 10-30 字,具体有信息量(含茶品名/主题),不夸张不标题党;
2. 正文 300-800 字,只基于素材中出现过的茶品、事实和观点来写,可以加入你人设视角的
   合理感受和延伸讨论,但绝不虚构素材里没有的年份、价格、数字、茶品;
3. 口语化、像真实茶友发帖,不要像文章或百科;不要暴露你是AI或提到"素材"二字;
4. 正文可用简单HTML(<b>加粗</b>),不要用图片,结尾可以留一个引战/讨论性问题;
5. 不要写"楼主""大家好"这类空洞开头,直接切入。

请严格按以下三段格式返回(不要JSON、不要markdown代码块、不要额外解释;每段独占一行开头):
TITLE:帖子标题
CONTENT:帖子正文HTML(可含换行)
QUESTION:结尾讨论问题一句话`;

  const res = await fetch(MINIMAX_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MINIMAX_API_KEY}` },
    body: JSON.stringify({
      model: MINIMAX_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.9,
      // MiniMax-M3: max_completion_tokens(非 max_tokens) + 显式关 thinking(默认 adaptive 太慢)
      max_completion_tokens: 1200,
      thinking: { type: "disabled" },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`MiniMax ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const text = (await res.json()).choices?.[0]?.message?.content || "";

  // 分段标记解析(DRY 实测 JSON 模式会被内容里的裸引号炸掉,标记式永不 parse 失败)
  const grab = (tag) => {
    const re = new RegExp(`^${tag}:\\s*([\\s\\S]*?)(?=\\n(?:TITLE|CONTENT|QUESTION):|$)`, "m");
    const m = text.match(re);
    return m ? m[1].trim() : "";
  };
  const out = { title: grab("TITLE"), content: grab("CONTENT"), question: grab("QUESTION") };
  if (!out.title || !out.content) {
    throw new Error(`unexpected model output shape: ${text.slice(0, 120)}`);
  }
  return out;
}

// ── 茶品配图(donghe SKU 实拍图,图文强相关,不虚构) ───────────────────
//
// 从草稿标题+正文提取茶品关键词(唛号/知名品名),在 donghe-skus.jsonl 里
// 匹配 name,命中则把该 SKU 的实拍图拷到 uploads/forum(公网可访问,
// R26b uploads 兜底路由保证立即可见),返回 URL 写入 article.images。
// 渲染层(R26 extractFeedImages)统一读 images 字段,详情页画廊直接生效。
// 匹配不到就无图草稿——宁缺毋滥,绝不硬凑无关图。

let SKU_INDEX = null;

function loadSkuIndex() {
  if (SKU_INDEX) return SKU_INDEX;
  SKU_INDEX = [];
  try {
    const lines = readFileSync(SKUS_FILE, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const s = JSON.parse(line);
        if (s && s.skuId && s.name) SKU_INDEX.push({ skuId: String(s.skuId), name: String(s.name) });
      } catch { /* skip */ }
    }
  } catch {
    log(`WARN: sku index unavailable (${SKUS_FILE}) — drafts will go imageless`);
  }
  return SKU_INDEX;
}

function pickSkuImage(title, content) {
  const skus = loadSkuIndex();
  if (skus.length === 0) return null;
  const text = `${title} ${content}`;

  // 候选关键词:唛号优先(区分度最高),其次知名品名
  const keywords = new Set();
  for (const m of text.matchAll(/(\d{4})/g)) keywords.add(m[1]);
  for (const name of ["88青", "大白菜", "孔雀", "老班章", "冰岛", "薄荷塘", "金大益", "轩辕号", "紫大益", "红大益"]) {
    if (text.includes(name)) keywords.add(name);
  }
  if (keywords.size === 0) return null;

  const hits = skus.filter((s) => {
    for (const k of keywords) if (s.name.includes(k)) return true;
    return false;
  });
  if (hits.length === 0) return null;

  const sku = pickRandom(hits);
  const src = `${SKU_IMG_DIR}/${sku.skuId}.jpeg`;
  if (!existsSync(src)) return null;
  const destName = `rag-${sku.skuId}.jpeg`;
  const dest = `${FORUM_IMG_DIR}/${destName}`;
  mkdirSync(FORUM_IMG_DIR, { recursive: true });
  if (!existsSync(dest)) copyFileSync(src, dest); // 幂等:同 SKU 复用同一张
  log(`sku image matched: ${sku.name} (${sku.skuId}) -> /uploads/forum/${destName}`);
  return `/uploads/forum/${destName}`;
}

// Gate 3: 硬校验,不过即抛
function validateDraft(d) {
  const title = String(d.title || "").trim();
  const plain = String(d.content || "").replace(/<[^>]*>/g, "").trim();
  if (title.length < 10 || title.length > 40) throw new Error(`title length ${title.length} out of 10-40`);
  if (plain.length < 150 || plain.length > 1000) throw new Error(`content length ${plain.length} out of 150-1000`);
  if (/<img/i.test(d.content)) throw new Error("content contains <img>");
  if (/作为AI|人工智能|语言模型/.test(plain)) throw new Error("AI self-exposure");
  return { title, content: String(d.content).trim() };
}

async function insertDraft({ title, content, question, boardId, authorId, source, hash, images }) {
  const id = randomUUID();
  const marker = `<!--rag-post:${hash}-->`;
  let ending = "";
  if (question && String(question).trim().length >= 6) {
    ending = `<p><b>${escapeSql(String(question).trim().slice(0, 80))}</b></p>`;
  }
  const summaryPlain = content.replace(/<[^>]*>/g, "").slice(0, 160);
  const summary = `${summaryPlain} [素材:${String(source).slice(0, 40)}]`;
  const imgs = (images || []).filter((u) => /^\/uploads\/forum\/rag-[a-zA-Z0-9-]+\.(jpeg|jpg|png|webp)$/.test(u));
  const imgsSql = imgs.length
    ? `ARRAY[${imgs.map((u) => `'${u}'`).join(",")}]::varchar[]`
    : `ARRAY[]::varchar[]`;

  await sql(`
    INSERT INTO articles (
      id, type, title, content, summary,
      "boardId", "authorId",
      "isPinned", "isEssence", "replyCount", "viewCount",
      "upvotes", "downvotes", status, flair,
      tags, images, "createdAt", "updatedAt"
    ) VALUES (
      '${id}', 'discussion', '${escapeSql(title)}', '${escapeSql(content)}${ending}${marker}', '${escapeSql(summary)}',
      '${boardId}', '${authorId}',
      false, false, 0, 0,
      0, 0, 'draft', 'share',
      ARRAY['品鉴', '茶友分享']::varchar[], ${imgsSql},
      NOW(), NOW()
    )
  `);
  return id;
}

// ── main ─────────────────────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  if (!MINIMAX_API_KEY) { console.error("ERROR: MINIMAX_API_KEY not set"); process.exit(1); }
  log(`=== Rag-post started (cap=${DAILY_CAP}${DRY_RUN ? ", DRY_RUN" : ""}) ===`);

  const [chunks, used, todayCount] = await Promise.all([
    loadChunks(), usedHashes(), countTodayDrafts(),
  ]);
  const fresh = chunks.filter((c) => !used.has(srcHash(c.source)));
  log(`chunks=${chunks.length} used=${used.size} fresh=${fresh.length} todayDrafts=${todayCount}`);
  if (fresh.length === 0) { log("no fresh chunks left — corpus exhausted"); return; }

  const slots = Math.max(0, DAILY_CAP - todayCount);
  if (slots === 0) { log(`daily cap reached (${todayCount}/${DAILY_CAP}) — skip`); return; }

  // 打乱取前 N 篇素材;同轮多位主笔不重复
  const picked = shuffle(fresh).slice(0, slots);
  const authorExclude = [];
  let ok = 0;

  for (const chunk of picked) {
    const hash = srcHash(chunk.source);
    try {
      const author = await pickAuthor(authorExclude);
      if (!author) throw new Error("no author candidate");
      authorExclude.push(author.id);

      const persona = pickRandom(PERSONAS);
      const d = validateDraft(await generateDraft(chunk, persona));
      const board = boardFor(String(chunk.text) + d.title);
      // 茶品配图:命中 donghe SKU 则拷实拍图到 uploads/forum 并写入 images
      const images = [];
      const imgUrl = pickSkuImage(d.title, d.content);
      if (imgUrl) images.push(imgUrl);

      if (DRY_RUN) {
        log(`[DRY] ${hash} by ${author.username}(${persona.style}) → ${board.slug} images=${images.length}`);
        log(`[DRY] title: ${d.title}`);
        log(`[DRY] content(${d.content.replace(/<[^>]*>/g, "").length}字): ${d.content.replace(/<[^>]*>/g, "").slice(0, 200)}...`);
        ok++;
        continue;
      }
      const id = await insertDraft({ ...d, boardId: board.id, authorId: author.id, source: chunk.source, hash, images });
      log(`draft created: ${id} "${d.title}" by ${author.username} in ${board.slug} [${chunk.source.slice(0, 50)}]`);
      ok++;
    } catch (e) {
      log(`draft failed for ${hash} (${chunk.source?.slice(0, 40)}): ${e.message}`);
    }
  }
  log(`=== Done: ${ok}/${picked.length} drafts ===`);
}

main().catch((e) => { log(`FATAL: ${e.message}`); process.exit(1); });
