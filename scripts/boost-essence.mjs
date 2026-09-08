#!/usr/bin/env node

/**
 * boost-essence.mjs — One-shot boost for frozen essence posts.
 *
 * Background: old essence posts got stuck at ~58 net votes. The legacy bot
 * pool was ~58 accounts (fixed May-23 cutoff) which saturated them (one vote
 * per bot per post via the unique constraint). After switching to a rolling
 * 129-bot pool, those posts STILL didn't grow because auto-vote's candidate
 * pool only covered "latest 80 posts + 48h new" — old essence posts fell out
 * of range and froze.
 *
 * This script gives every essence post below MIN_TARGET a one-time boost to a
 * randomized 80-120 (organic-looking spread), drawing from the current bot
 * pool and skipping bots that already voted (respects unique constraint).
 *
 * Idempotent: re-running only tops up posts still below their randomized run.
 * Run inside the ws container (has pg + DATABASE_URL):
 *   docker exec puer-hub-ws node /app/scripts/boost-essence.mjs
 */

import { randomUUID } from "node:crypto";

const DB_URL = process.env.DATABASE_URL;
const MIN_TARGET = 80;
const MAX_TARGET = 120;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  const q = (sql, params) => client.query(sql, params);

  // Bot pool — identical criteria to auto-vote.mjs getBotUsers()
  // (level>=1 dropped — widens pool from ~56 to ~128, see auto-vote.mjs note)
  const { rows: users } = await q(
    `SELECT id FROM users WHERE "banStatus" = 'active' AND "createdAt" < NOW() - INTERVAL '7 days'`
  );
  log(`Bot pool: ${users.length}`);
  if (users.length < 20) {
    console.error("ERROR: bot pool too small");
    process.exit(1);
  }

  // Essence posts still below the floor
  const { rows: posts } = await q(`
    SELECT id, title, upvotes, downvotes, "authorId"
    FROM articles
    WHERE "isEssence" = true AND status = 'published'
      AND (upvotes - downvotes) < ${MIN_TARGET}
    ORDER BY upvotes ASC
  `);
  log(`Essence posts below ${MIN_TARGET}: ${posts.length}`);

  let totalBoosted = 0;
  let postsTouched = 0;
  for (const post of posts) {
    const target = MIN_TARGET + Math.floor(Math.random() * (MAX_TARGET - MIN_TARGET + 1));
    const net = post.upvotes - post.downvotes;
    const need = target - net;
    if (need <= 0) continue;

    // Skip bots that already voted this post (unique constraint userId+refId)
    const { rows: voted } = await q(`SELECT "userId" FROM votes WHERE "refId" = $1`, [post.id]);
    const votedSet = new Set(voted.map((v) => v.userId));
    const available = users.filter((u) => u.id !== post.authorId && !votedSet.has(u.id));
    const voters = shuffle(available).slice(0, need);
    if (voters.length === 0) continue;

    const values = voters
      .map((u) => `('${randomUUID()}', '${u.id}', '${post.id}', 1, NOW())`)
      .join(",");
    const res = await q(`
      INSERT INTO votes (id, "userId", "refId", value, "createdAt")
      VALUES ${values}
      ON CONFLICT ("userId", "refId") DO NOTHING
    `);
    const inserted = res.rowCount || 0;
    if (inserted > 0) {
      await q(`UPDATE articles SET upvotes = upvotes + ${inserted} WHERE id = '${post.id}'`);
      totalBoosted += inserted;
      postsTouched += 1;
      log(`  +${inserted} → "${post.title.slice(0, 24)}..." (net ${net}→${net + inserted}, target ${target})`);
    }
  }

  log(`=== Done: ${totalBoosted} votes across ${postsTouched} posts ===`);
  await client.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
