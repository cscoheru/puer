#!/usr/bin/env node

/**
 * auto-publish-facebook.mjs — Publish one essence video/day to a Facebook Page.
 *
 * Cron (host): docker exec puer-hub-app node /app/scripts/auto-publish-facebook.mjs
 * Dry-run:    docker exec -e DRY_RUN=1 puer-hub-app node /app/scripts/auto-publish-facebook.mjs
 *
 * Uses Graph API file_url: Facebook fetches the public video URL itself
 * (https://puer.im/uploads/videos/{base}.mp4) — no byte upload from our side.
 */
import {
  FB, DRY_RUN, log,
  pickCandidate, genFbCopy, uploadFacebook, recordPublish,
} from "./lib/publish-helpers.mjs";

const SITE = "https://puer.im";

async function main() {
  log("=== Auto-publish Facebook started ===");
  if (!FB.pageId || !FB.pageToken) {
    log("FB creds not set yet (Phase B) — skipping.");
    process.exit(0);
  }

  const c = await pickCandidate("facebook");
  if (!c) {
    log("No candidate (essence + video + not yet published to FB). Exiting.");
    process.exit(0);
  }
  log(`Candidate: "${c.title.slice(0, 30)}..." (${c.id})`);

  let copy;
  try {
    copy = await genFbCopy(c);
  } catch (e) {
    log(`Copy generation failed: ${e.message}`);
    process.exit(1);
  }
  log(`Title: ${copy.title}`);

  const fileUrl = `${SITE}${c.videoUrl}`; // public, FB fetches it
  if (DRY_RUN) {
    log(`DRY_RUN=1 — not uploading. file_url=${fileUrl}`);
    await recordPublish({ articleId: c.id, platform: "facebook", title: copy.title, status: "pending" });
    process.exit(0);
  }

  try {
    const r = await uploadFacebook({ fileUrl, title: copy.title, description: copy.caption });
    await recordPublish({ articleId: c.id, platform: "facebook", externalId: r.id, externalUrl: r.url, title: copy.title, status: "published" });
    log(`✓ Published: ${r.url}`);
  } catch (e) {
    await recordPublish({ articleId: c.id, platform: "facebook", title: copy.title, status: "failed", error: e.message });
    log(`✗ Failed: ${e.message}`);
    if (e.tokenFailed) log("→ Page token failed/expired. Re-generate a long-lived Page Access Token.");
    process.exit(1); // circuit-break
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
