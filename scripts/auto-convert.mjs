#!/usr/bin/env node

/**
 * auto-convert.mjs — DEPRECATED. Disabled as of the tea-draft-runner cutover.
 *
 * This legacy pipeline turned tasting notes into PUBLISHED forum posts via
 * DeepSeek rewrite + random author/board/image shuffle — exactly the
 * untrustworthy behavior the new runner replaces. It is retained only so the
 * old crontab entry keeps resolving until T8 removes it; it must NOT run.
 *
 * It self-disables unless AUTO_CONVERT_LEGACY_FORCE=1 is set, so a stale cron
 * tick (or a manual invocation) is a safe no-op instead of publishing more
 * AI-rewritten content. Use scripts/auto-post.mjs (the new runner CLI) instead.
 *
 * Usage (inside app container):  node /app/scripts/auto-convert.mjs
 */

if (process.env.AUTO_CONVERT_LEGACY_FORCE !== "1") {
  console.log(
    "[auto-convert] DISABLED — superseded by the tea-draft runner (scripts/auto-post.mjs). " +
      "Set AUTO_CONVERT_LEGACY_FORCE=1 to run the legacy pipeline anyway.",
  );
  process.exit(0);
}
console.warn("[auto-convert] LEGACY FORCE override active — running deprecated DeepSeek pipeline.");


import {
  DEEPSEEK_API_KEY, BOARDS,
  log, sqlSingle, pickRandom,
  generateVideo, generateContent, insertPost,
} from "./lib/post-helpers.mjs";

// ── Notes already converted → exclude ───────────────────────────────

async function convertedNoteIds() {
  const rows = await sqlSingle(`
    SELECT content FROM articles WHERE content LIKE '%<!--auto-post:%-->%'
  `);
  const ids = new Set();
  for (const r of rows) {
    for (const m of r.content.matchAll(/<!--auto-post:([a-f0-9-]+)-->/g)) {
      ids.add(m[1]);
    }
  }
  return ids;
}

// ── Fresh unconverted notes (last 1 hour) ───────────────────────────

async function pickFreshNotes(excludeIds) {
  const excl = excludeIds.size
    ? `AND tn.id NOT IN (${[...excludeIds].map((id) => `'${id}'`).join(",")})`
    : "";
  return sqlSingle(`
    SELECT tn.id, tn.title, tn.content, tn.images, tn.summary,
           tn.appearance, tn.color, tn.aroma, tn.taste, tn.aftertaste,
           tn."brewMethod", tn."waterTemp", tn."teaWeight", tn."steepCount",
           t.name as tea_name, t.brand, t.year, t.type as tea_type,
           u.username as original_author
    FROM tasting_notes tn
    JOIN teas t ON tn."teaId" = t.id
    JOIN users u ON tn."authorId" = u.id
    WHERE tn."createdAt" > NOW() - INTERVAL '1 hour'
      AND tn.images IS NOT NULL
      AND tn.images::text NOT IN ('null', '[]')
      AND jsonb_array_length(tn.images::jsonb) >= 4
      ${excl}
    ORDER BY tn."createdAt" DESC
  `);
}

// ── Pick an established user (same criteria as auto-post) ───────────

async function pickUser() {
  const rows = await sqlSingle(`
    WITH recent AS (
      SELECT "authorId" FROM articles
      WHERE "createdAt" > NOW() - INTERVAL '3 days'
        AND content LIKE '%auto-post%'
      GROUP BY "authorId" HAVING COUNT(*) >= 2
    )
    SELECT id, username FROM users
    WHERE level >= 1 AND "banStatus" = 'active'
      AND "createdAt" < NOW() - INTERVAL '7 days'
      AND id NOT IN (SELECT "authorId" FROM recent)
    ORDER BY RANDOM() LIMIT 1
  `);
  if (rows.length > 0) return rows[0];
  const fallback = await sqlSingle(`
    SELECT id, username FROM users
    WHERE level >= 1 AND "banStatus" = 'active'
      AND "createdAt" < NOW() - INTERVAL '7 days'
    ORDER BY RANDOM() LIMIT 1
  `);
  return fallback[0];
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  log("=== Auto-convert started ===");
  if (!DEEPSEEK_API_KEY) {
    console.error("ERROR: DEEPSEEK_API_KEY not set");
    process.exit(1);
  }

  const excludeIds = await convertedNoteIds();
  const fresh = await pickFreshNotes(excludeIds);
  if (fresh.length === 0) {
    log("No fresh unconverted notes (last 1h), exiting.");
    process.exit(0);
  }
  log(`Fresh notes to convert: ${fresh.length}`);

  let converted = 0;
  for (const note of fresh) {
    if (!Array.isArray(note.images) || note.images.length < 4) continue;
    try {
      const videoUrl = generateVideo(note.images);
      const { title, content } = await generateContent(note);
      const user = await pickUser();
      const board = pickRandom(BOARDS);
      await insertPost({ title, content, videoUrl, boardId: board.id, userId: user.id, noteId: note.id });
      log(`Converted "${note.title.slice(0, 24)}..." → post`);
      converted++;
    } catch (err) {
      log(`  Failed to convert "${note.title.slice(0, 24)}...": ${err.message.split("\n")[0]}`);
    }
  }
  log(`=== Auto-convert complete: ${converted}/${fresh.length} ===`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
