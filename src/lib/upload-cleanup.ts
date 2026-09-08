/**
 * Bounded TTL sweeper for abandoned chunked uploads.
 *
 * The in-process per-user concurrency gate bounds uploads in flight, but a
 * user can start many uploads over time and never complete them, leaving
 * orphan chunk dirs under CHUNK_ROOT. This is the durable backstop: it
 * reclaims expired uploads WITHOUT ever becoming an unbounded delete.
 *
 * Hard safety properties (the whole point of this module):
 *  - It walks EXACTLY two levels under a fixed root: root/userId/uploadId.
 *    It never recurses deeper and never touches anything above root.
 *  - It deletes a dir's contents ONLY when a valid manifest is present and
 *    older than the TTL. The files removed are exactly the manifest's
 *    declared chunk indices plus manifest.json — nothing else.
 *  - A dir with NO manifest, an UNREADABLE manifest, or any tampering is
 *    LEFT UNTOUCHED (quarantine-by-leaving). We never delete what we cannot
 *    identify. This is the line between reclamation and the old data-loss
 *    primitive.
 *  - Every path is produced through buildContainedPath, so traversal cannot
 *    escape root; symlinks and non-regular files are skipped before unlink.
 *
 * The pure decision (expired?) is separated from fs so the sweeper is fully
 * drivable from tests with an injected clock.
 */
import { readdir, readFile, rmdir, unlink, lstat } from "fs/promises";
import type { Dirent } from "fs";
import path from "path";
import {
  buildContainedPath,
  parseManifest,
  expectedChunkNames,
  MANIFEST_FILENAME,
  type UploadManifest,
} from "./upload-policy.ts";

export interface CleanupReport {
  scanned: number; // uploadId directories examined
  expired: number; // reclaimed (valid manifest + older than TTL)
  skipped: number; // no/invalid manifest or non-dir — left untouched
  errors: string[]; // bounded log for ops (≤ MAX_ERRORS_LOGGED)
}

const MAX_ERRORS_LOGGED = 20;

/**
 * Sweep `root` two levels deep and reclaim expired uploads.
 *
 * @param root  CHUNK_ROOT (fixed). Only this dir is read.
 * @param ttlMs an upload older than this (by manifest.createdAt) is reclaimable.
 * @param now   injected epoch ms (testability); production passes Date.now().
 */
export async function cleanupExpiredUploads(
  root: string,
  ttlMs: number,
  now: number,
): Promise<CleanupReport> {
  const report: CleanupReport = { scanned: 0, expired: 0, skipped: 0, errors: [] };
  const rootResolved = path.resolve(root);

  let userEntries: Dirent[];
  try {
    userEntries = await readdir(rootResolved, { withFileTypes: true });
  } catch {
    // Root doesn't exist yet (no uploads ever happened) — nothing to sweep.
    return report;
  }

  for (const userEntry of userEntries) {
    if (!userEntry.isDirectory()) continue;
    let userPath: string;
    try {
      userPath = buildContainedPath(rootResolved, userEntry.name);
    } catch {
      report.skipped++; // name failed containment — leave it, don't guess
      continue;
    }

    let uploadEntries: Dirent[];
    try {
      uploadEntries = await readdir(userPath, { withFileTypes: true });
    } catch {
      continue; // user dir vanished or unreadable — skip silently
    }

    for (const upEntry of uploadEntries) {
      if (!upEntry.isDirectory()) continue;
      report.scanned++;
      let uploadDir: string;
      try {
        uploadDir = buildContainedPath(userPath, upEntry.name);
      } catch {
        report.skipped++;
        continue;
      }
      try {
        await reclaimIfExpired(uploadDir, userPath, ttlMs, now, report);
      } catch (e) {
        pushError(report, `${userEntry.name}/${upEntry.name}: ${errMsg(e)}`);
      }
    }
  }
  return report;
}

async function reclaimIfExpired(
  uploadDir: string,
  userPath: string,
  ttlMs: number,
  now: number,
  report: CleanupReport,
): Promise<void> {
  // Load the manifest. No manifest / corrupt / tampered → DO NOT delete.
  let manifest: UploadManifest;
  try {
    const raw = await readFile(buildContainedPath(uploadDir, MANIFEST_FILENAME), "utf8");
    manifest = parseManifest(raw);
  } catch {
    report.skipped++;
    return;
  }

  const created = Date.parse(manifest.createdAt);
  if (!Number.isFinite(created)) {
    // createdAt parses as a string in policy but isn't a real date — treat as
    // unidentifiable rather than guessing an age.
    report.skipped++;
    return;
  }
  if (now - created < ttlMs) return; // not expired yet

  // Expired AND identifiable: remove ONLY the declared chunks + manifest.
  const names = [...expectedChunkNames(manifest.totalChunks), MANIFEST_FILENAME];
  await Promise.all(
    names.map(async (name) => {
      const p = buildContainedPath(uploadDir, name);
      try {
        const st = await lstat(p);
        if (st.isSymbolicLink() || !st.isFile()) return;
        await unlink(p);
      } catch {
        /* missing is fine */
      }
    }),
  );
  // Non-recursive rmdir: only succeeds if dir is now empty. If a stray file
  // we don't recognize remains, the dir stays — we never force-remove it.
  let removed = false;
  try {
    await rmdir(uploadDir);
    removed = true;
  } catch {
    pushError(report, `${path.basename(uploadDir)}: non-empty after reclaim, left in place`);
  }
  if (removed) {
    // Opportunistically drop the now-maybe-empty user namespace. Non-recursive:
    // succeeds only if the user has no other uploads left. Never forces.
    await rmdir(userPath).catch(() => {});
  }
  report.expired++;
}

function pushError(report: CleanupReport, msg: string): void {
  if (report.errors.length < MAX_ERRORS_LOGGED) report.errors.push(msg);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── Production trigger ────────────────────────────────────────────────────
// Opportunistic, rate-limited, fire-and-forget. Called from the chunk upload
// path so the sweeper runs only when uploads are actually happening (which is
// exactly when orphans accumulate) — no separate cron required. Idempotent and
// safe to invoke from multiple processes; a failed sweep only logs.
const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // at most once per 15 min per process
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2h: generous over any realistic resume
let lastSweepAt = 0;

/** Rate-limited trigger for the route to call on each chunk POST. */
export function maybeSweepUploadTemp(root: string): void {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  void cleanupExpiredUploads(root, DEFAULT_TTL_MS, now).catch((e) => {
    console.warn("upload temp sweep failed:", errMsg(e));
  });
}
