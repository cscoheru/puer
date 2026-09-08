#!/usr/bin/env node
// Auto-essence: promote posts meeting a quality threshold to isEssence.
// Threshold (中等): net upvotes >= 10, replies >= 5, age >= 3 days, not
// already essence. Notifies the author. Pure pg (no prisma) so it runs in the
// ws-server container via child_process.spawn from the node-cron scheduler.
import { randomUUID } from "node:crypto";

const DB_URL = process.env.DATABASE_URL;
const NET_VOTE_MIN = 10;
const REPLY_MIN = 5;
const AGE_DAYS = 3;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function query(text, params = []) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await client.query(text, params);
  } finally {
    await client.end();
  }
}

async function main() {
  if (!DB_URL) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  // Posts meeting threshold, not yet essence
  const { rows } = await query(`
    SELECT id, "authorId", title FROM articles
    WHERE status = 'published'
      AND "isEssence" = false
      AND (upvotes - downvotes) >= ${NET_VOTE_MIN}
      AND "replyCount" >= ${REPLY_MIN}
      AND "createdAt" < NOW() - INTERVAL '${AGE_DAYS} days'
  `);
  log(`Eligible for essence: ${rows.length}`);

  let promoted = 0;
  for (const post of rows) {
    try {
      await query(
        `UPDATE articles SET "isEssence" = true, "essencedAt" = NOW() WHERE id = $1`,
        [post.id],
      );
      await query(
        `INSERT INTO notifications (id, type, content, link, "userId") VALUES ($1, 'essence', $2, $3, $4)`,
        [
          randomUUID(),
          `你的帖子《${post.title}》因优质互动被设为精华`,
          `/forum/thread/${post.id}`,
          post.authorId,
        ],
      );
      promoted++;
      log(`Promoted ${post.id}: ${post.title}`);
    } catch (e) {
      log(`Failed ${post.id}: ${e.message.split("\n")[0]}`);
    }
  }
  log(`Done: ${promoted} promoted`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
