/**
 * rag-post.mjs — RAG-grounded draft generator (R28 → R28d).
 *
 * 每日从「茶问」同一份 RAG 语料 (rag-data/knowledge-chunks.jsonl, 973 条真实
 * 公众号茶文) 选一篇未用过的素材 → MiniMax M3 识别品牌/茶品 → 查 teas 表
 * 找 teaId → 从该 tea 关联的 tasting_notes 选"加权综合分"最高的茶记 →
 * 取该茶记的 images[] + videoUrl → 随机活跃老用户主笔 → MiniMax M3 人设化
 * 改写成论坛帖 → 硬校验 → 写入 status='draft' 草稿,进 /admin/drafts 后台
 * 人工审核后才发布。绝不直接发布。
 *
 * R28d 切换: 旧管线用关键词匹配 donghe-skus.jsonl 命中过度错配(811 个 SKU
 *   随机挑,生成的「熟茶老五样里的7262」无图);新管线用茶记质量排序,
 *   1686 条茶记 1587 条有图,任何 auto 出的帖子至少 1 张图。
 *
 * 防盲目创作五道闸:
 *   1. 幂等: content 埋 <!--rag-post:{srcHash}--> marker,同一篇素材永不复用;
 *   2. 接地: prompt 附素材原文,要求只基于素材展开,不虚构年份/价格/数字;
 *   3. 校验: 标题 10-40 字、正文(strip HTML)150-1000 字、禁 <img>、禁 AI 自曝;
 *   4. 日上限: RAG_POST_DAILY_CAP (默认 2),当日已有足够 rag 草稿则跳过;
 *   5. fail-safe: 单篇任何失败(检索/识别/生成/校验/写库)只跳过不写半成品。
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
import { readFileSync } from "node:fs";
import {
  MINIMAX_API_KEY, BOARDS, sql, sqlSingle, log, pickRandom, escapeSql,
} from "./lib/post-helpers.mjs";

const MINIMAX_BASE = "https://api.minimax.cn/v1/chat/completions";
const MINIMAX_MODEL = "MiniMax-M3";
const CHUNKS_FILE = process.env.RAG_CHUNKS_FILE || "/opt/puer-hub/rag-data/knowledge-chunks.jsonl";
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

// ── 茶品识别 + 茶记质量选图 (R28d) ──────────────────────────────
//
// 旧管线 (R28): 用正则 /(\d{4})/g 抓标题年份+唛号去 SKU name 匹配。
//   实测「熟茶老五样里的7262」命中 811 个 SKU 随机错配,生成的帖子无图。
// 新管线 (R28d): 用 MiniMax 从 chunk 文本识别品牌+茶品 → 查 teas 表得 teaId
//   → 按"加权综合分 = ln(正文长度)*2 + 图数*1.5 + 视频奖励5"选最优茶记
//   → 直接拿该茶记的 images[] + videoUrl 写入帖子。
//   图片路径直接用 tasting_notes.images 里的 /uploads/evernote/... 已是公网
//   URL,零拷贝(已验证 curl 200)。识别失败/无茶记则降级无图草稿。

async function identifyTea(chunk) {
  const material = String(chunk.text || "").slice(0, 800);
  const prompt = `从下面这段茶文中,提取出讨论的核心茶品。
返回格式(独占两行,不要 JSON / 不要 markdown 代码块 / 不要额外解释):
TEA_BRAND:品牌(大益/下关/陈升号/老同志/福今/雨林/澜沧古古等,其他常见品牌也可)
TEA_NAME:茶品名(唛号或品名,如 7262/7572/7542/金大益/紫大益)

素材来源:${chunk.source}
素材正文(前 800 字):${material}

要求:
- 如果素材讨论的是通用知识(无具体茶品),品牌/茶品名都写 NONE
- 茶品名只取核心唛号或品名,不要带年份/批次`;

  const res = await fetch(MINIMAX_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MINIMAX_API_KEY}` },
    body: JSON.stringify({
      model: MINIMAX_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_completion_tokens: 200,
      thinking: { type: "disabled" },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`identifyTea MiniMax ${res.status}`);
  const text = (await res.json()).choices?.[0]?.message?.content || "";
  const grab = (tag) => {
    const m = text.match(new RegExp(`^${tag}:\\s*(.+?)$`, "m"));
    return m ? m[1].trim() : "";
  };
  const brand = grab("TEA_BRAND");
  const name = grab("TEA_NAME");
  if (!brand || brand === "NONE" || !name) return null;

  // teas 表查:brand + (name 模糊 OR aliases 命中)
  const rows = await sqlSingle(`
    SELECT t.id, t.name FROM teas t
    LEFT JOIN unnest(t.aliases) AS a ON TRUE
    WHERE t."deletedAt" IS NULL
      AND t.brand = '${escapeSql(brand)}'
      AND (t.name ILIKE '%${escapeSql(name)}%' OR a = '${escapeSql(name)}')
    ORDER BY length(t.name) DESC
    LIMIT 5
  `);
  return rows[0]?.id || null;
}

// 加权:ln(正文长度)*2 + 图数*1.5 + 视频奖励5
async function pickTopTastingNoteMedia(teaId) {
  const rows = await sqlSingle(`
    SELECT id, images, "videoUrl",
      length(content) AS clen,
      COALESCE(jsonb_array_length(images), 0) AS inum,
      ln(GREATEST(length(content), 1)) * 2.0
        + COALESCE(jsonb_array_length(images), 0) * 1.5
        + CASE WHEN "videoUrl" IS NOT NULL AND "videoUrl" <> '' THEN 5.0 ELSE 0 END
        AS quality
    FROM tasting_notes
    WHERE "teaId" = '${escapeSql(teaId)}'
      AND images IS NOT NULL
      AND COALESCE(jsonb_array_length(images), 0) > 0
    ORDER BY quality DESC, length(content) DESC
    LIMIT 1
  `);
  return rows[0] || null;
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

async function insertDraft({ title, content, question, boardId, authorId, source, hash, images, videoUrl }) {
  const id = randomUUID();
  const marker = `<!--rag-post:${hash}-->`;
  let ending = "";
  if (question && String(question).trim().length >= 6) {
    ending = `<p><b>${escapeSql(String(question).trim().slice(0, 80))}</b></p>`;
  }
  const summaryPlain = content.replace(/<[^>]*>/g, "").slice(0, 160);
  const summary = `${summaryPlain} [素材:${String(source).slice(0, 40)}]`;
  // R28d: 接受 tasting_notes.images 路径 /uploads/evernote/... 与旧路径 /uploads/forum/rag-...
  const imgs = (images || []).filter((u) =>
    typeof u === "string" && /^\/uploads\/(evernote\/[a-zA-Z0-9._-]+|forum\/rag-[a-zA-Z0-9._-]+)\.(jpe?g|png|webp)$/i.test(u)
  );
  const imgsSql = imgs.length
    ? `ARRAY[${imgs.map((u) => `'${u}'`).join(",")}]::varchar[]`
    : `ARRAY[]::varchar[]`;
  const videoSql = videoUrl ? `'${escapeSql(String(videoUrl))}'` : `NULL`;

  await sql(`
    INSERT INTO articles (
      id, type, title, content, summary,
      "boardId", "authorId",
      "isPinned", "isEssence", "replyCount", "viewCount",
      "upvotes", "downvotes", status, flair,
      tags, images, "videoUrl", "createdAt", "updatedAt"
    ) VALUES (
      '${id}', 'discussion', '${escapeSql(title)}', '${escapeSql(content)}${ending}${marker}', '${escapeSql(summary)}',
      '${boardId}', '${authorId}',
      false, false, 0, 0,
      0, 0, 'draft', 'share',
      ARRAY['品鉴', '茶友分享']::varchar[], ${imgsSql}, ${videoSql},
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

      // R28d: MiniMax 识别茶品 → teas 表 → 茶记质量选图视频
      let teaId = null;
      try {
        teaId = await identifyTea(chunk);
        if (teaId) log(`identified tea: ${teaId} for "${d.title}"`);
      } catch (e) {
        log(`identifyTea failed: ${e.message.slice(0, 100)}`);
      }

      const images = [];
      let videoUrl = null;
      if (teaId) {
        const top = await pickTopTastingNoteMedia(teaId);
        if (top) {
          if (Array.isArray(top.images)) images.push(...top.images);
          if (top.videoUrl) videoUrl = top.videoUrl;
          log(`tasting-note media: note=${top.id} images=${top.inum} video=${videoUrl ? "yes" : "no"} quality=${Number(top.quality).toFixed(1)}`);
        } else {
          log(`no tasting-note with images for teaId=${teaId} — draft will go imageless`);
        }
      }

      if (DRY_RUN) {
        log(`[DRY] ${hash} by ${author.username}(${persona.style}) → ${board.slug} images=${images.length} video=${videoUrl ? "yes" : "no"}`);
        log(`[DRY] title: ${d.title}`);
        log(`[DRY] content(${d.content.replace(/<[^>]*>/g, "").length}字): ${d.content.replace(/<[^>]*>/g, "").slice(0, 200)}...`);
        ok++;
        continue;
      }

      // R28d 注释承诺: 任何 auto 出的帖子至少 1 张图.
      // 验证: 若 images=[] 且 videoUrl=NULL, skip 而非写无图草稿.
      // 避免 /admin/drafts 后台被无图草稿污染人工审核队列.
      // 已知代价: skip 不写 marker, 同一 chunk 下次 cron 可能被重选
      // (chunks=857 / cap=2 / Day 一次最多浪费 2 个 API 调用).
      if (images.length === 0 && !videoUrl) {
        log(`skip ${hash} - no media (would violate R28d promise, chunk will be retried tomorrow)`);
        continue;
      }
      const id = await insertDraft({ ...d, boardId: board.id, authorId: author.id, source: chunk.source, hash, images, videoUrl });
      log(`draft created: ${id} "${d.title}" by ${author.username} in ${board.slug} images=${images.length} video=${videoUrl ? "yes" : "no"} [${chunk.source.slice(0, 50)}]`);
      ok++;
    } catch (e) {
      log(`draft failed for ${hash} (${chunk.source?.slice(0, 40)}): ${e.message}`);
    }
  }
  log(`=== Done: ${ok}/${picked.length} drafts ===`);
}

main().catch((e) => { log(`FATAL: ${e.message}`); process.exit(1); });
