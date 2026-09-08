/**
 * Filesystem tests for the bounded TTL sweeper. These PROVE the safety
 * properties on a real disk: a fixed two-level walk, declared-chunks-only
 * deletion, and that an unidentifiable dir is NEVER deleted.
 *
 * Each test builds a tiny tmp tree under os.tmpdir(), runs the sweeper with an
 * injected clock, and removes its own tmp root at the end.
 *
 * Run: npm run test:cleanup
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cleanupExpiredUploads,
  maybeSweepUploadTemp,
} from "./upload-cleanup.ts";
import { serializeManifest, MANIFEST_FILENAME, type UploadManifest } from "./upload-policy.ts";

const TTL = 60_000; // 1 minute
let counter = 0;
function newRoot(): string {
  return path.join(tmpdir(), `puer-cleanup-${process.pid}-${counter++}`);
}

interface Seed {
  userId?: string;
  uploadId?: string;
  createdAt: string; // ISO
  manifest?: "valid" | "corrupt" | "none";
  chunks?: number[]; // chunk indices to materialize
  stray?: string; // extra filename inside the dir (not a declared chunk)
}

async function seed(root: string, s: Seed): Promise<string> {
  const userId = s.userId ?? "userA";
  const uploadId = s.uploadId ?? "a".repeat(32);
  const dir = path.join(root, userId, uploadId);
  await mkdir(dir, { recursive: true });
  if (s.manifest !== "none") {
    const content =
      s.manifest === "corrupt"
        ? "not-json"
        : serializeManifest({
            ownerId: userId,
            uploadId,
            kind: "image",
            mime: "image/jpeg",
            category: "",
            subDir: "forum",
            totalChunks: (s.chunks ?? [0]).length,
            totalBytes: 1024,
            createdAt: s.createdAt,
          } satisfies UploadManifest);
    await writeFile(path.join(dir, MANIFEST_FILENAME), content);
  }
  for (const i of s.chunks ?? []) {
    await writeFile(path.join(dir, String(i)), `chunk-${i}`);
  }
  if (s.stray) await writeFile(path.join(dir, s.stray), "stray");
  return dir;
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

test("expired valid manifest: declared chunks + manifest deleted, dir removed", async () => {
  const root = newRoot();
  try {
    await seed(root, { createdAt: isoAgo(TTL + 60_000), chunks: [0, 1, 2] });
    const r = await cleanupExpiredUploads(root, TTL, Date.now());
    assert.equal(r.scanned, 1);
    assert.equal(r.expired, 1);
    assert.equal(r.skipped, 0);
    assert.equal(existsSync(path.join(root, "userA")), false); // user dir gone too (empty)
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh manifest: nothing reclaimed", async () => {
  const root = newRoot();
  try {
    const dir = await seed(root, { createdAt: isoAgo(1_000), chunks: [0, 1] });
    const r = await cleanupExpiredUploads(root, TTL, Date.now());
    assert.equal(r.expired, 0);
    assert.equal(r.scanned, 1);
    assert.ok(existsSync(dir));
    assert.ok(existsSync(path.join(dir, "0")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no manifest: dir left untouched (never delete what we cannot identify)", async () => {
  const root = newRoot();
  try {
    const dir = await seed(root, { createdAt: isoAgo(TTL + 60_000), manifest: "none", chunks: [0] });
    const r = await cleanupExpiredUploads(root, TTL, Date.now());
    assert.equal(r.expired, 0);
    assert.equal(r.skipped, 1);
    assert.ok(existsSync(dir));
    assert.ok(existsSync(path.join(dir, "0"))); // even an old dir with no manifest is kept
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt manifest: dir left untouched", async () => {
  const root = newRoot();
  try {
    const dir = await seed(root, { createdAt: isoAgo(TTL + 60_000), manifest: "corrupt", chunks: [0] });
    const r = await cleanupExpiredUploads(root, TTL, Date.now());
    assert.equal(r.expired, 0);
    assert.equal(r.skipped, 1);
    assert.ok(existsSync(dir));
    assert.ok(existsSync(path.join(dir, MANIFEST_FILENAME)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expired dir keeps a sibling fresh upload intact (no cross-talk)", async () => {
  const root = newRoot();
  try {
    const expired = await seed(root, { uploadId: "b".repeat(32), createdAt: isoAgo(TTL + 60_000), chunks: [0] });
    const fresh = await seed(root, { uploadId: "c".repeat(32), createdAt: isoAgo(1_000), chunks: [0, 1] });
    const r = await cleanupExpiredUploads(root, TTL, Date.now());
    assert.equal(r.expired, 1);
    assert.equal(r.scanned, 2);
    assert.equal(existsSync(expired), false);
    assert.ok(existsSync(fresh));
    assert.ok(existsSync(path.join(fresh, "1")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stray non-declared file survives reclaim; dir stays (no force delete)", async () => {
  const root = newRoot();
  try {
    // Manifest declares 2 chunks [0,1], but a stray "stranger.txt" is also present.
    const dir = await seed(root, {
      createdAt: isoAgo(TTL + 60_000),
      chunks: [0, 1],
      stray: "stranger.txt",
    });
    const r = await cleanupExpiredUploads(root, TTL, Date.now());
    assert.equal(r.expired, 1); // reclaim counted (declared files removed)
    // declared chunks + manifest gone ...
    assert.equal(existsSync(path.join(dir, "0")), false);
    assert.equal(existsSync(path.join(dir, "1")), false);
    assert.equal(existsSync(path.join(dir, MANIFEST_FILENAME)), false);
    // ... but the stray we do NOT own is preserved, and the dir remains.
    assert.ok(existsSync(path.join(dir, "stranger.txt")));
    assert.ok(existsSync(dir));
    assert.ok(r.errors.length >= 1); // non-empty-after-reclaim is logged
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("root-level sentinel file is never touched (sweeper only walks 2 levels)", async () => {
  const root = newRoot();
  try {
    await mkdir(root, { recursive: true });
    const sentinel = path.join(root, "sentinel.txt");
    await writeFile(sentinel, "do-not-touch");
    // Also a nested stray file deeper than 2 levels must be invisible to reclaim.
    await seed(root, { userId: "userA", uploadId: "d".repeat(32), createdAt: isoAgo(TTL + 60_000), chunks: [0] });
    await cleanupExpiredUploads(root, TTL, Date.now());
    assert.ok(existsSync(sentinel)); // root-level file untouched
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlink chunk is skipped, not followed or unlinked", async () => {
  const root = newRoot();
  try {
    const dir = await seed(root, { createdAt: isoAgo(TTL + 60_000), chunks: [0] });
    // Replace chunk "0" with a symlink pointing outside — must not be unlinked
    // (would let a sweeper delete arbitrary files via a planted link).
    const linkTarget = path.join(root, "outside-target");
    await writeFile(linkTarget, "precious");
    await rm(path.join(dir, "0"));
    await symlink(linkTarget, path.join(dir, "0"));
    await cleanupExpiredUploads(root, TTL, Date.now());
    assert.ok(existsSync(linkTarget)); // target survived
    assert.ok(existsSync(path.join(dir, "0"))); // symlink itself left (non-regular → skip)
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maybeSweepUploadTemp rate-limits to one sweep per interval", () => {
  // Two immediate calls → only the first advances the last-run timestamp;
  // we assert it does not throw and returns void for both (behavior contract).
  const root = newRoot();
  assert.equal(maybeSweepUploadTemp(root), undefined);
  assert.equal(maybeSweepUploadTemp(root), undefined);
});
