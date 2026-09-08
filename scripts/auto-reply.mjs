#!/usr/bin/env node

/**
 * auto-reply.mjs — Auto-reply to forum posts with diverse user personas
 *
 * Picks posts (preferring low-reply ones) → generates contextual replies
 * via DeepSeek → inserts as comments from random users
 *
 * Environment:
 *   DATABASE_URL   — PostgreSQL connection
 *   DEEPSEEK_API_KEY — DeepSeek API key
 */

import { randomUUID } from "node:crypto";

// ── Config ──────────────────────────────────────────────────────────
const DB_URL = process.env.DATABASE_URL;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = "deepseek-chat";
const DEEPSEEK_BASE = "https://api.deepseek.com/v1/chat/completions";

// User persona archetypes for reply style diversity
const PERSONAS = [
  { style: "资深老茶客", tone: "自信、权威、喜欢引用自己存茶和品茶的真实经验，能说出具体年份、仓储变化和口感细节", intensity: 0.6 },
  { style: "暴躁老哥", tone: "直来直去、措辞激烈甚至偏激，喜欢质疑和反驳，但总能在暴怒中夹带干货", intensity: 0.95 },
  { style: "文艺茶人", tone: "温和、感性、喜欢用比喻和诗意描述品茶体验，关注茶汤的美学和情感", intensity: 0.3 },
  { style: "理性分析师", tone: "冷静客观、数据导向、喜欢对比不同年份批次、拆解用料工艺和转化逻辑", intensity: 0.4 },
  { style: "杠精", tone: "专门挑刺、唱反调、找逻辑漏洞，但会说出一堆有理有据的反面论据", intensity: 0.9 },
  { style: "入门小白", tone: "好奇、虚心提问但有时问出有意思的入门问题，引发老茶友科普欲望", intensity: 0.5 },
  { style: "老炮杠王", tone: "毫不客气地怼人，措辞尖锐、经常拿出压箱底的硬核知识和藏品说话", intensity: 1.0 },
  { style: "佛系茶友", tone: "云淡风轻、不争不抢、喜欢分享自己的冲泡心得和日常喝茶感悟", intensity: 0.2 },
  { style: "技术党", tone: "专注于工艺细节、仓储条件、冲泡参数（水温、投茶量、坐杯时间），喜欢钻牛角尖", intensity: 0.5 },
  { style: "键盘侠", tone: "言辞犀利、喜欢上纲上线，动不动就上升到行业道德和市场乱象", intensity: 0.85 },
  { style: "和事佬", tone: "喜欢调和矛盾、总结各方观点、补全信息，善于把讨论引导到建设性方向", intensity: 0.3 },
  { style: "阴阳怪气型", tone: "话里有话、明褒暗贬、冷嘲热讽，但总能说到点子上", intensity: 0.8 },
];

// Reply engagement types — ensures diverse response directions
const REPLY_TYPES = [
  {
    name: "深度探讨",
    desc: "针对帖子的某个具体观点展开深入分析，提供更多背景信息、历史沿革或市场现状。用你的经验补充作者没有提到但重要的维度。",
    weight: 3,
  },
  {
    name: "真诚提问",
    desc: "基于帖子内容提出2-3个有深度的好问题，展现你对这个话题的思考和好奇。问题要具体，不能是泛泛的'有什么感受'。",
    weight: 2,
  },
  {
    name: "质疑挑战",
    desc: "对帖子的某个结论或判断提出合理的质疑，给出不同的见解或反面案例。要有理有据，不是无脑黑。",
    weight: 2,
  },
  {
    name: "经验分享",
    desc: "分享你自己喝过同一款茶或同类茶的体验，对比口感差异、仓储变化或冲泡心得。要说出具体的感受细节。",
    weight: 3,
  },
  {
    name: "新发现延伸",
    desc: "从帖子话题延伸出去，引出相关的茶品、品牌或知识点，拓展讨论的广度。比如'说到这个就不得不提XX'。",
    weight: 2,
  },
  {
    name: "观点交锋",
    desc: "直接回应帖子或已有回复中的某个观点，亮明自己的立场并给出论据。适合跟帖讨论场景，容易引发更多互动。",
    weight: 2,
  },
];

// ── Helpers ─────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function sql(query) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await client.query(query);
  } finally {
    await client.end();
  }
}

async function sqlRows(query) {
  const result = await sql(query);
  return result.rows;
}

function escapeSql(str) {
  return str.replace(/'/g, "''").replace(/\\/g, "\\\\");
}

// ── Step 1: Pick a post to reply to ─────────────────────────────────

async function pickPost() {
  // 60% chance: reply to posts with 0-1 replies (boost engagement)
  // 30% chance: reply to auto-generated posts (build discussion)
  // 10% chance: reply to any post
  const rand = Math.random();

  let query;
  if (rand < 0.6) {
    // Low-reply posts
    query = `
      SELECT a.id, a.title, a.content, a."videoUrl", a.images,
             a."replyCount", a."createdAt", a.flair,
             b.name as board_name,
             u.username as author_name
      FROM articles a
      LEFT JOIN boards b ON a."boardId" = b.id
      JOIN users u ON a."authorId" = u.id
      WHERE a.status = 'published'
        AND a."replyCount" <= 1
      ORDER BY RANDOM() LIMIT 1
    `;
  } else if (rand < 0.9) {
    // Auto-generated posts (build discussion threads)
    query = `
      SELECT a.id, a.title, a.content, a."videoUrl", a.images,
             a."replyCount", a."createdAt", a.flair,
             b.name as board_name,
             u.username as author_name
      FROM articles a
      LEFT JOIN boards b ON a."boardId" = b.id
      JOIN users u ON a."authorId" = u.id
      WHERE a.status = 'published'
        AND a.content LIKE '%<!--auto-post-->%'
        AND a."replyCount" < 8
      ORDER BY RANDOM() LIMIT 1
    `;
  } else {
    // Any post
    query = `
      SELECT a.id, a.title, a.content, a."videoUrl", a.images,
             a."replyCount", a."createdAt", a.flair,
             b.name as board_name,
             u.username as author_name
      FROM articles a
      LEFT JOIN boards b ON a."boardId" = b.id
      JOIN users u ON a."authorId" = u.id
      WHERE a.status = 'published'
      ORDER BY RANDOM() LIMIT 1
    `;
  }

  const rows = await sqlRows(query);
  return rows[0] || null;
}

// ── Step 2: Pick existing replies for context ──────────────────────

async function pickExistingReplies(articleId) {
  const rows = await sqlRows(`
    SELECT c.content, u.username
    FROM comments c
    JOIN users u ON c."authorId" = u.id
    WHERE c."articleId" = '${articleId}'
    ORDER BY c."createdAt" DESC LIMIT 5
  `);
  return rows;
}

// ── Step 3: Pick a user (avoid post author and recent replies) ──────

async function pickUser(excludeAuthorId, articleId) {
  // Get users who haven't replied to this post recently
  const rows = await sqlRows(`
    WITH replied AS (
      SELECT "authorId" FROM comments
      WHERE "articleId" = '${articleId}'
    )
    SELECT id, username FROM users
    WHERE level >= 1
      AND "banStatus" = 'active'
      AND "createdAt" < '2026-05-23'
      AND id != '${excludeAuthorId}'
      AND id NOT IN (SELECT "authorId" FROM replied)
    ORDER BY RANDOM() LIMIT 3
  `);

  if (rows.length > 0) return pickRandom(rows);

  // Fallback: any active user except author
  const fallback = await sqlRows(`
    SELECT id, username FROM users
    WHERE level >= 1 AND "banStatus" = 'active'
      AND "createdAt" < '2026-05-23'
      AND id != '${excludeAuthorId}'
    ORDER BY RANDOM() LIMIT 1
  `);
  return fallback[0];
}

// ── Step 4: Generate reply via DeepSeek ─────────────────────────────

function pickWeightedReplyType() {
  const totalWeight = REPLY_TYPES.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * totalWeight;
  for (const t of REPLY_TYPES) {
    r -= t.weight;
    if (r <= 0) return t;
  }
  return REPLY_TYPES[0];
}

async function generateReply(post, persona, existingReplies) {
  const plainContent = (post.content || "")
    .replace(/<[^>]*>/g, "")
    .replace(/<!--auto-post-->/g, "")
    .slice(0, 1000);

  const repliesContext = existingReplies.length > 0
    ? `\n\n已有回复（可以针对这些观点回应、补充或反驳）：\n${existingReplies.map((r) => `- ${r.username}: ${r.content.replace(/<[^>]*>/g, "").slice(0, 200)}`).join("\n")}`
    : "";

  const replyType = pickWeightedReplyType();

  const intensityGuide = persona.intensity >= 0.8
    ? "措辞要犀利直接，可以有轻微的攻击性（但不要粗俗），多用反问句。"
    : persona.intensity >= 0.5
    ? "回复要有立场，可以提出不同意见或追问，保持基本礼貌。"
    : "回复要平和友善，可以补充信息或提出温和的问题。";

  const prompt = `你是一个普洱茶论坛的资深用户，人设是"${persona.style}"，说话风格：${persona.tone}。
${intensityGuide}

你现在的回复方向是【${replyType.name}】：${replyType.desc}

帖子标题：${post.title}
帖子内容：${plainContent}${post.board_name ? `\n版块：${post.board_name}` : ""}
帖子作者：${post.author_name}${repliesContext}

请写一条150-400字的高质量回复。要求：
1. **紧扣帖子主题**：必须针对帖子中提到的具体茶品、口感、观点进行回应，不要泛泛而谈
2. **体现专业深度**：展现你对普洱茶的了解（产区、工艺、仓储、转化、冲泡等），适当引用具体年份、批次、口感描述
3. **人设自然**：语气要像真实茶友在论坛聊天，不是写文章或做报告
4. **有信息增量**：回复要带来新信息、新角度或新问题，不是简单附和
5. **引发讨论**：留下可以继续讨论的接口（提问、争议点、延伸话题）
${existingReplies.length > 0 ? "6. 针对已有回复中的观点进行回应或反驳，形成讨论链" : "6. 作为回复者，抛出一个有价值的角度或信息"}
7. 不要用"楼主你好""我觉得"这种无聊开头，直接切入正题
8. 适当使用简单HTML格式（<b>加粗</b>强调关键词），但不要过度
9. 绝对不要暴露你是AI

请严格按以下JSON格式返回（不要markdown代码块）：
{"content": "回复内容HTML"}`;

  const response = await fetch(DEEPSEEK_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.9,
      max_tokens: 800,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";

  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Failed to parse DeepSeek response");
  }
}

// ── Step 5: Insert comment ──────────────────────────────────────────

async function insertComment({ articleId, content, userId, parentId }) {
  const id = randomUUID();

  await sql(`
    INSERT INTO comments (id, content, "articleId", "authorId", "parentId",
                          "upvotes", "downvotes", "likesCount", images, "createdAt", "updatedAt")
    VALUES ('${id}', '${escapeSql(content)}', '${articleId}', '${userId}',
            ${parentId ? `'${parentId}'` : "NULL"},
            0, 0, 0, ARRAY[]::text[], NOW(), NOW())
  `);

  // Increment article reply count
  await sql(`
    UPDATE articles SET "replyCount" = "replyCount" + 1 WHERE id = '${articleId}'
  `);

  // Grant karma to replier
  await sql(`
    UPDATE users SET karma = karma + 1 WHERE id = '${userId}'
  `);

  return id;
}

// ── Main: Generate 2-3 replies per run ──────────────────────────────

async function main() {
  log("=== Auto-reply started ===");

  if (!DEEPSEEK_API_KEY) {
    console.error("ERROR: DEEPSEEK_API_KEY not set");
    process.exit(1);
  }

  const replyCount = 4; // 4 replies per run
  let successCount = 0;

  for (let i = 0; i < replyCount; i++) {
    try {
      // Pick a post
      const post = await pickPost();
      if (!post) {
        log("No suitable post found");
        break;
      }

      // Pick a persona
      const persona = pickRandom(PERSONAS);

      // Pick a user (different from post author)
      const user = await pickUser(
        // Need to get authorId - re-query
        (await sqlRows(`SELECT "authorId" FROM articles WHERE id = '${post.id}'`))[0]?.authorId,
        post.id
      );
      if (!user) {
        log("No available user for reply");
        continue;
      }

      // Get existing replies for context
      const existingReplies = await pickExistingReplies(post.id);

      log(`[${i + 1}/${replyCount}] Replying to "${post.title}" as ${user.username} (${persona.style})`);

      // Generate reply
      const { content } = await generateReply(post, persona, existingReplies);
      const charCount = content.replace(/<[^>]*>/g, "").length;
      log(`  Generated (${charCount}字): ${content.replace(/<[^>]*>/g, "").slice(0, 100)}...`);

      // Optionally reply to an existing comment (30% chance for nested discussions)
      let parentId = null;
      if (existingReplies.length > 0 && Math.random() < 0.3) {
        const parentComment = pickRandom(existingReplies);
        const parentRow = await sqlRows(`
          SELECT id FROM comments
          WHERE "articleId" = '${post.id}'
          ORDER BY RANDOM() LIMIT 1
        `);
        if (parentRow.length > 0) parentId = parentRow[0].id;
      }

      // Insert comment
      await insertComment({
        articleId: post.id,
        content,
        userId: user.id,
        parentId,
      });

      successCount++;
      log(`  Posted as ${user.username}`);

      // Small delay between replies
      if (i < replyCount - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (err) {
      log(`  Error: ${err.message}`);
    }
  }

  log(`=== Auto-reply complete: ${successCount} replies posted ===`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
