#!/usr/bin/env node

/**
 * auto-vote.mjs — Daily engagement boost (quality-focused)
 *
 * Ranks candidate posts (new + hot + essence) by a content-quality composite
 * score, then concentrates votes on the TOP 5 only — no more spraying a few
 * votes across every post. Top posts get +15~25 each run so quality content
 * climbs fast; likes/follows also focus on the same top set.
 *
 * Environment: DATABASE_URL
 */

import { randomUUID } from "node:crypto";

// ── Config ──────────────────────────────────────────────────────────
const DB_URL = process.env.DATABASE_URL;
const TOP_N = 5;       // only the top-N posts by contentScore get votes
const VOTE_MIN = 15;   // votes per top post per run (random in [MIN, MAX])
const VOTE_MAX = 25;

// ── Helpers ─────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
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
  return (await sql(query)).rows;
}

// ── Step 1: Get candidate posts (new 48h + hot 45d + all essence) ───

async function getCandidatePosts() {
  const rows = await sqlRows(`
    WITH new_posts AS (
      SELECT a.id, a.title, a.upvotes, a.downvotes, a."replyCount",
             a."viewCount", a."createdAt", a."authorId",
             a."videoUrl", a.content, a."tastingScores",
             u.username as author_name,
             'new' as source
      FROM articles a
      JOIN users u ON a."authorId" = u.id
      WHERE a.status = 'published'
        AND a."createdAt" > NOW() - INTERVAL '48 hours'
        AND a."boardId" IS NOT NULL
    ),
    hot_posts AS (
      SELECT a.id, a.title, a.upvotes, a.downvotes, a."replyCount",
             a."viewCount", a."createdAt", a."authorId",
             a."videoUrl", a.content, a."tastingScores",
             u.username as author_name,
             'hot' as source
      FROM articles a
      JOIN users u ON a."authorId" = u.id
      WHERE a.status = 'published'
        AND a."boardId" IS NOT NULL
        AND (a."hotOverride" IS NULL OR a."hotOverride" = 'pinned')
        AND a."createdAt" > NOW() - INTERVAL '45 days'
      ORDER BY a."createdAt" DESC
      LIMIT 120
    ),
    essence_posts AS (
      -- 长青内容:精华帖无论多老都纳入候选(否则老精华帖票数会冻结)。
      SELECT a.id, a.title, a.upvotes, a.downvotes, a."replyCount",
             a."viewCount", a."createdAt", a."authorId",
             a."videoUrl", a.content, a."tastingScores",
             u.username as author_name,
             'hot' as source
      FROM articles a
      JOIN users u ON a."authorId" = u.id
      WHERE a.status = 'published'
        AND a."boardId" IS NOT NULL
        AND a."isEssence" = true
    ),
    combined AS (
      SELECT * FROM new_posts
      UNION
      SELECT * FROM hot_posts
      UNION
      SELECT * FROM essence_posts
    )
    SELECT DISTINCT ON (id) * FROM combined
    ORDER BY id, source
  `);
  return rows;
}

// ── Step 2: Get eligible bot users (active, registered >7d) ─────────

async function getBotUsers() {
  // No `level >= 1` filter — that capped the pool at ~56 and (with the votes
  // unique constraint) froze every post at ~58 votes. level-0 included → ~128.
  return sqlRows(`
    SELECT id, username FROM users
    WHERE "banStatus" = 'active'
      AND "createdAt" < NOW() - INTERVAL '7 days'
    ORDER BY RANDOM()
  `);
}

// ── Step 3: Content-quality composite score (0-100, content-weighted) ─

function contentScore(post) {
  let s = 0;
  // 内容质量 60
  const imgs = (post.content || "").match(/<img/g) || [];
  if (post.videoUrl) s += 20;
  else if (imgs.length >= 3) s += 15;
  else if (imgs.length >= 1) s += 8;
  // 品鉴评分完整度(5 项里 ≥3 项有值)
  const ts = post.tastingScores;
  let scoreFields = 0;
  if (ts && typeof ts === "object" && !Array.isArray(ts)) {
    for (const k of ["appearance", "color", "aroma", "taste", "aftertaste"]) {
      if (ts[k] != null) scoreFields++;
    }
  }
  if (scoreFields >= 3) s += 15;
  // 正文字数
  const textLen = (post.content || "").replace(/<[^>]*>/g, "").length;
  if (textLen > 300) s += 10;
  // 互动 30
  const net = Math.max(0, (post.upvotes || 0) - (post.downvotes || 0));
  s += Math.min(20, Math.log1p(net) * 5);
  s += Math.min(10, Math.log1p(post.replyCount || 0) * 3);
  // 新鲜度 10
  const ageDays = (Date.now() - new Date(post.createdAt).getTime()) / 86400000;
  if (ageDays <= 7) s += 10;
  else if (ageDays <= 15) s += 5;
  return s;
}

// ── Step 4: Concentrate upvotes on Top-N posts ──────────────────────

async function upvotePosts(posts, users) {
  const userIds = users.map((u) => u.id);

  const scored = posts.map((p) => ({ ...p, _score: contentScore(p) }));
  scored.sort((a, b) => b._score - a._score);
  const top = scored.slice(0, TOP_N);
  log(
    `Top ${top.length} by contentScore: ` +
      top.map((p) => `${p._score.toFixed(0)}·${(p.title || "").slice(0, 10)}`).join(" | ")
  );

  // Spread votes across the pool; cap per-user so one account can't dominate.
  const userUsage = new Map();
  const MAX_VOTES_PER_USER = VOTE_MAX;
  function pickAvailableUsers(excludeAuthorId, count) {
    const eligible = userIds.filter(
      (id) => id !== excludeAuthorId && (userUsage.get(id) || 0) < MAX_VOTES_PER_USER
    );
    return shuffleArray(eligible).slice(0, count);
  }

  let totalVotes = 0;
  for (const post of top) {
    const toAdd = VOTE_MIN + Math.floor(Math.random() * (VOTE_MAX - VOTE_MIN + 1));
    const voters = pickAvailableUsers(post.authorId, toAdd);
    if (voters.length === 0) continue;

    const values = voters
      .map((uid) => `('${randomUUID()}', '${uid}', '${post.id}', 1, NOW())`)
      .join(",\n");
    const result = await sql(`
      INSERT INTO votes (id, "userId", "refId", value, "createdAt")
      VALUES ${values}
      ON CONFLICT ("userId", "refId") DO NOTHING
    `);

    const inserted = result.rowCount || 0;
    if (inserted > 0) {
      await sql(`UPDATE articles SET upvotes = upvotes + ${inserted} WHERE id = '${post.id}'`);
      voters.forEach((uid) => userUsage.set(uid, (userUsage.get(uid) || 0) + 1));
      totalVotes += inserted;
      log(
        `  [Top${TOP_N}] "${post.title.slice(0, 24)}..." score=${post._score.toFixed(0)} +${inserted} ` +
          `(${post.upvotes - post.downvotes}→${post.upvotes - post.downvotes + inserted} net)`
      );
    }
  }
  return { totalVotes, topPosts: top };
}

// ── Step 5: Like the top posts ──────────────────────────────────────

async function likePosts(posts, users) {
  const userIds = users.map((u) => u.id);
  let totalLikes = 0;

  const toLike = posts.filter(() => Math.random() < 0.6);
  const userUsage = new Map();
  const MAX_LIKES_PER_USER = 6;

  for (const post of toLike) {
    const eligible = userIds.filter((id) => id !== post.authorId && (userUsage.get(id) || 0) < MAX_LIKES_PER_USER);
    if (eligible.length === 0) continue;

    const count = Math.floor(Math.random() * 4) + 2;
    const likers = shuffleArray(eligible).slice(0, count);
    const values = likers
      .map((uid) => `('${randomUUID()}', 'article', '${post.id}', '${post.id}', '${uid}', NOW())`)
      .join(",\n");

    const result = await sql(`
      INSERT INTO likes (id, type, "refId", "articleId", "userId", "createdAt")
      VALUES ${values}
      ON CONFLICT ("userId", type, "refId") DO NOTHING
    `);

    const inserted = result.rowCount || 0;
    if (inserted > 0) {
      likers.forEach((uid) => userUsage.set(uid, (userUsage.get(uid) || 0) + 1));
      totalLikes += inserted;
    }
  }
  return totalLikes;
}

// ── Step 6: Follow the top posts' authors ───────────────────────────

async function followAuthors(posts, users) {
  const authorScore = new Map();
  for (const post of posts) {
    const score = (post.upvotes || 0) + (post.replyCount || 0) * 2;
    authorScore.set(post.authorId, (authorScore.get(post.authorId) || 0) + score);
  }
  const topAuthors = [...authorScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id]) => id);
  if (topAuthors.length === 0) return 0;

  const userIds = users.map((u) => u.id);
  let totalFollows = 0;

  for (const authorId of topAuthors) {
    const count = Math.floor(Math.random() * 6) + 3;
    const followers = shuffleArray(userIds.filter((id) => id !== authorId)).slice(0, count);
    if (followers.length === 0) continue;

    const values = followers.map((fid) => `('${randomUUID()}', '${fid}', '${authorId}', NOW())`).join(",\n");
    const result = await sql(`
      INSERT INTO user_follows (id, "followerId", "followingId", "createdAt")
      VALUES ${values}
      ON CONFLICT ("followerId", "followingId") DO NOTHING
    `);

    const inserted = result.rowCount || 0;
    if (inserted > 0) {
      await sql(`UPDATE users SET "followerCount" = "followerCount" + ${inserted} WHERE id = '${authorId}'`);
      for (const fid of followers) {
        await sql(`UPDATE users SET "followingCount" = "followingCount" + 1 WHERE id = '${fid}'`);
      }
      totalFollows += inserted;
    }
  }
  return totalFollows;
}

// ── Step 7: Upvote quality comments ─────────────────────────────────

async function upvoteComments(users) {
  const userIds = users.map((u) => u.id);
  const comments = await sqlRows(`
    SELECT c.id, c."articleId", c."authorId", c."upvotes", c."downvotes"
    FROM comments c
    JOIN articles a ON c."articleId" = a.id
    WHERE a.status = 'published'
      AND a."createdAt" > NOW() - INTERVAL '48 hours'
    ORDER BY c."createdAt" DESC
    LIMIT 30
  `);
  if (comments.length === 0) return 0;

  let totalVotes = 0;
  for (const comment of comments) {
    const count = Math.floor(Math.random() * 4) + 2;
    const voters = shuffleArray(userIds.filter((id) => id !== comment.authorId)).slice(0, count);
    if (voters.length === 0) continue;

    const values = voters.map((uid) => `('${randomUUID()}', '${uid}', '${comment.id}', 1, NOW())`).join(",\n");
    const result = await sql(`
      INSERT INTO votes (id, "userId", "refId", value, "createdAt")
      VALUES ${values}
      ON CONFLICT ("userId", "refId") DO NOTHING
    `);

    const inserted = result.rowCount || 0;
    if (inserted > 0) {
      await sql(`UPDATE comments SET upvotes = upvotes + ${inserted} WHERE id = '${comment.id}'`);
      totalVotes += inserted;
    }
  }
  return totalVotes;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  log("=== Auto-vote started ===");

  const users = await getBotUsers();
  log(`Eligible users (>7d, active): ${users.length}`);
  if (users.length < 5) {
    log("ERROR: Not enough eligible users");
    process.exit(1);
  }

  const posts = await getCandidatePosts();
  log(`Candidate posts: ${posts.length} (new + hot + essence)`);
  if (posts.length === 0) {
    log("No posts to vote on");
    process.exit(0);
  }

  const { totalVotes, topPosts } = await upvotePosts(posts, users);
  log(`Votes: ${totalVotes} inserted (top ${topPosts.length})`);

  const likes = await likePosts(topPosts, users);
  log(`Likes: ${likes} inserted`);
  const follows = await followAuthors(topPosts, users);
  log(`Follows: ${follows} inserted`);
  const commentVotes = await upvoteComments(users);
  log(`Comment votes: ${commentVotes} inserted`);

  log(`=== Auto-vote complete: ${totalVotes}v + ${likes}l + ${follows}f + ${commentVotes}cv ===`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
