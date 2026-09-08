#!/usr/bin/env node

/**
 * auto-publish-youtube.mjs — Publish one essence video/day to YouTube.
 *
 * Cron (host): docker exec puer-hub-app node /app/scripts/auto-publish-youtube.mjs
 * Dry-run:    docker exec -e DRY_RUN=1 puer-hub-app node /app/scripts/auto-publish-youtube.mjs
 *
 * Guardrails: 1/day, DeepSeek-differentiated copy, dedup via external_publishes,
 * silent skip if YT creds unset, circuit-break (no retry) on API rejection.
 * Source video: watermarked /uploads/videos/{base}.mp4 (public, host-persisted).
 */
import {
  YT, DRY_RUN, VIDEO_CONTAINER_DIR, log,
  pickCandidate, genYoutubeCopy, uploadYoutube, recordPublish,
} from "./lib/publish-helpers.mjs";

async function main() {
  log("=== Auto-publish YouTube started ===");
  if (!YT.clientId || !YT.clientSecret || !YT.refreshToken) {
    log("YT creds not set yet (Phase B) — skipping.");
    process.exit(0);
  }

  const c = await pickCandidate("youtube");
  if (!c) {
    log("No candidate (essence + video + not yet published to YT). Exiting.");
    process.exit(0);
  }
  log(`Candidate: "${c.title.slice(0, 30)}..." (${c.id})`);

  let copy;
  try {
    copy = await genYoutubeCopy(c);
  } catch (e) {
    log(`Copy generation failed: ${e.message}`);
    process.exit(1);
  }
  log(`Title: ${copy.title}`);
  log(`Tags: ${copy.tags.join(", ")}`);

  if (DRY_RUN) {
    log("DRY_RUN=1 — not uploading. Recording pending.");
    await recordPublish({ articleId: c.id, platform: "youtube", title: copy.title, status: "pending" });
    process.exit(0);
  }

  const base = c.videoUrl.split("/").pop();
  const filePath = `${VIDEO_CONTAINER_DIR}/${base}`;
  try {
    const r = await uploadYoutube({ filePath, title: copy.title, description: copy.description, tags: copy.tags });
    await recordPublish({ articleId: c.id, platform: "youtube", externalId: r.id, externalUrl: r.url, title: copy.title, status: "published" });
    log(`✓ Published: ${r.url}`);
  } catch (e) {
    await recordPublish({ articleId: c.id, platform: "youtube", title: copy.title, status: "failed", error: e.message });
    log(`✗ Failed: ${e.message}`);
    if (e.tokenFailed) log("→ Token refresh failed. Re-run authorize-youtube.mjs to obtain a new refresh token.");
    process.exit(1); // circuit-break: do NOT retry-spam
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
