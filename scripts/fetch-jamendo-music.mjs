#!/usr/bin/env node

/**
 * fetch-jamendo-music.mjs — download royalty-free (CC-BY, commercial-use) background
 * music from Jamendo into /uploads/music/ for generateVideo to mix in.
 *
 * Run inside app container: node /app/scripts/fetch-jamendo-music.mjs
 * Requires JAMENDO_CLIENT_ID env (free key from https://developer.jamendo.com/v3.0).
 * Idempotent: skips tracks already downloaded.
 */
import { writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CLIENT_ID = process.env.JAMENDO_CLIENT_ID;
const MUSIC_DIR = "/app/public/uploads/music";
const TARGET = 18;

async function main() {
  if (!CLIENT_ID) {
    console.error("ERROR: JAMENDO_CLIENT_ID not set");
    process.exit(1);
  }
  mkdirSync(MUSIC_DIR, { recursive: true });
  const existing = new Set(
    readdirSync(MUSIC_DIR)
      .filter((f) => f.endsWith(".mp3"))
      .map((f) => f.replace(/\.mp3$/, ""))
  );

  // CC-BY ambient tracks (calm background, commercial-use OK; NC excluded).
  const searchUrl =
    `https://api.jamendo.com/v3.0/tracks/?client_id=${CLIENT_ID}` +
    `&format=json&limit=80&tags=ambient&license_ccby=true` +
    `&audioformat=mp32&include=musicinfo&order=popularity_month`;
  const data = await (await fetch(searchUrl)).json();
  const tracks = (data.results || []).filter((t) => t.audio && !existing.has(String(t.id)));
  console.log(`Jamendo: ${data.results?.length || 0} results, ${tracks.length} new (have ${existing.size})`);

  let downloaded = 0;
  for (const t of tracks) {
    if (downloaded >= TARGET) break;
    try {
      const buf = Buffer.from(await (await fetch(t.audio)).arrayBuffer());
      const id = String(t.id);
      writeFileSync(join(MUSIC_DIR, `${id}.mp3`), buf);
      writeFileSync(
        join(MUSIC_DIR, `${id}.json`),
        JSON.stringify(
          { track: t.name, artist: t.artist_name, license: t.license || "cc-by", url: t.shareurl || "" },
          null,
          2
        )
      );
      downloaded++;
      console.log(`  ✓ ${t.name} — ${t.artist_name} [${t.license}]`);
    } catch (e) {
      console.error(`  ✗ ${t.name}: ${e.message}`);
    }
  }
  console.log(`=== Done: ${downloaded} downloaded, ${readdirSync(MUSIC_DIR).filter((f) => f.endsWith(".mp3")).length} total in ${MUSIC_DIR} ===`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
