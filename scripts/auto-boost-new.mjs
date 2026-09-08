#!/usr/bin/env node

/**
 * auto-boost-new.mjs — Cold-start boost for fresh posts (every 3h).
 *
 * New posts get trapped in a no-engagement dead loop: auto-vote's Top5 picks
 * posts by contentScore (which weights existing engagement), so fresh posts
 * with zero interaction never get picked → never get votes → low hotScore →
 * never reach the hot ranking → never hit the essence threshold.
 *
 * This breaks the loop: each run gives 48h-old posts a small vote boost
 * (+3~5) and 1-2 DeepSeek replies from the bot pool, so they enter the
 * hotScore algorithm's view. Posts already taking off (net>=15 or reply>=8)
 * are skipped — they don't need cold start.
 *
 * Run inside app container (has DeepSeek + pg): node /app/scripts/auto-boost-new.mjs
 */

import { randomUUID } from "node:crypto";
import {
  DB_URL, DEEPSEEK_API_KEY,
  log, sql, sqlSingle, pickRandom, shuffleArray, escapeSql,
} from "./lib/post-helpers.mjs";

const DEEPSEEK_BASE = "https://api.deepseek.com/v1/chat/completions";

const PERSONAS = [
  { style: "好奇小白", tone: "刚入坑,不懂就问,语气真诚谦逊,常说'请问''不太懂'" },
  { style: "普通茶客", tone: "日常喝茶的普通人,分享简单感受,不用专业术语,随和" },
  { style: "求教型", tone: "带着具体问题请教,如'我这泡法对吗''这茶还能存吗'" },
  { style: "佛系茶友", tone: "云淡风轻,短句,聊日常喝茶的惬意" },
  { style: "捧场型", tone: "热情但简短,点赞/想试/求楼主多分享" },
  { style: "半懂型", tone: "懂一点但不确定,常说'好像''我记得''说不好',不把话说满" },
  { style: "感性茶友", tone: "聊喝茶心情和氛围,偏文艺但短,不分析数据" },
];

async function getBotUsers() {
  return sqlSingle(`
    SELECT id FROM users
    WHERE "banStatus" = 'active' AND "createdAt" < NOW() - INTERVAL '7 days'
  `);
}

async function getFreshPosts() {
  // 48h new posts, not private, not yet taken off (skip if already hot)
  return sqlSingle(`
    SELECT a.id, a.title, a.content, a.upvotes, a.downvotes, a."replyCount", a."authorId"
    FROM articles a
    WHERE a.status = 'published'
      AND a."boardId" IS NOT NULL
      AND (a.visibility IS NULL OR a.visibility != 'private')
      AND a."createdAt" > NOW() - INTERVAL '48 hours'
      AND (a.upvotes - a.downvotes) < 15
      AND a."replyCount" < 8
    ORDER BY a."createdAt" DESC
  `);
}

async function getVotedUserIds(articleId) {
  const rows = await sqlSingle(`SELECT "userId" FROM votes WHERE "refId" = '${articleId}'`);
  return new Set(rows.map((r) => r.userId));
}

async function voteBatch(articleId, voters) {
  const values = voters
    .map((uid) => `('${randomUUID()}', '${uid}', '${articleId}', 1, NOW())`)
    .join(",");
  const res = await sql(`
    INSERT INTO votes (id, "userId", "refId", value, "createdAt")
    VALUES ${values}
    ON CONFLICT ("userId", "refId") DO NOTHING
  `);
  return res.rowCount || 0;
}

async function generateReply(post) {
  const persona = pickRandom(PERSONAS);
  const plain = (post.content || "")
    .replace(/<[^>]*>/g, "")
    .replace(/<!--auto-post:[a-z0-9-]+-->/g, "")
    .slice(0, 800);
  const prompt = `你是普洱茶论坛的普通用户，人设"${persona.style}"，说话风格：${persona.tone}。
针对下面帖子写一条**简短**回复（30-80字）。要求：
1. 像真实茶友随口回一句，短、口语、自然。
2. 可用 1-2 个 emoji（🍵😂👍🤔等），别堆砌。
3. 不要硬充专家、不下权威结论；不懂就问。
4. 不要堆砌/套用专业术语（年份/仓储/工艺/拼配），不确定就别说。
5. 不要编造具体仓储年份、口感数据、历史背景。
直接返回回复正文纯文本，不要 JSON/markdown/标题/引号。

帖子标题：${post.title}
帖子内容：${plain}`;

  const res = await fetch(DEEPSEEK_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.9,
      max_tokens: 200,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 100)}`);
  const text = (await res.json()).choices?.[0]?.message?.content?.trim();
  return text || null;
}

async function insertComment({ articleId, content, userId }) {
  const id = randomUUID();
  await sql(`
    INSERT INTO comments (id, content, "articleId", "authorId", "parentId",
                          "upvotes", "downvotes", "likesCount", images, "createdAt", "updatedAt")
    VALUES ('${id}', '${escapeSql(content)}', '${articleId}', '${userId}',
            NULL, 0, 0, 0, ARRAY[]::text[], NOW(), NOW())
  `);
  await sql(`UPDATE articles SET "replyCount" = "replyCount" + 1 WHERE id = '${articleId}'`);
  await sql(`UPDATE users SET karma = karma + 1 WHERE id = '${userId}'`);
}

async function main() {
  log("=== Auto-boost-new started ===");
  if (!DEEPSEEK_API_KEY) {
    console.error("ERROR: DEEPSEEK_API_KEY not set");
    process.exit(1);
  }

  const users = await getBotUsers();
  const userIds = users.map((u) => u.id);
  log(`Bot pool: ${userIds.length}`);
  if (userIds.length < 10) {
    console.error("ERROR: bot pool too small");
    process.exit(1);
  }

  const posts = await getFreshPosts();
  log(`Fresh posts (48h, not yet taken off): ${posts.length}`);
  if (posts.length === 0) {
    log("Nothing to boost, exiting.");
    process.exit(0);
  }

  let totalVotes = 0;
  let totalReplies = 0;
  for (const post of posts) {
    // Votes: +3~5 from pool, skip users who already voted or the author
    const voted = await getVotedUserIds(post.id);
    const eligible = userIds.filter((id) => id !== post.authorId && !voted.has(id));
    const voteN = 3 + Math.floor(Math.random() * 3); // 3-5
    const voters = shuffleArray(eligible).slice(0, voteN);
    let voteInserts = 0;
    if (voters.length > 0) {
      voteInserts = await voteBatch(post.id, voters);
      if (voteInserts > 0) {
        await sql(`UPDATE articles SET upvotes = upvotes + ${voteInserts} WHERE id = '${post.id}'`);
        totalVotes += voteInserts;
      }
    }

    // Replies: 1-2 DeepSeek replies from random old users
    const replyN = 1 + Math.floor(Math.random() * 2); // 1-2
    let postReplies = 0;
    for (let i = 0; i < replyN; i++) {
      try {
        const replier = shuffleArray(userIds.filter((id) => id !== post.authorId))[0];
        if (!replier) break;
        const content = await generateReply(post);
        if (!content) continue;
        await insertComment({ articleId: post.id, content, userId: replier });
        postReplies++;
        totalReplies++;
      } catch (err) {
        log(`  reply failed for "${post.title.slice(0, 16)}...": ${err.message.split("\n")[0]}`);
      }
    }
    log(`  +${voteInserts}v +${postReplies}r "${post.title.slice(0, 20)}..."`);
  }
  log(`=== Done: ${totalVotes} votes + ${totalReplies} replies across ${posts.length} posts ===`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
