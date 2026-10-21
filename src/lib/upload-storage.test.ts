/**
 * Invariant tests for the public/private storage split.
 *
 * The bug these guard against: the unwatermarked video originals and the
 * chunk staging directory lived under public/uploads/, which made them
 * (a) fetchable by anyone who guessed a filename and (b) destroyed on every
 * container recreate. A future refactor that "tidies" these paths back under
 * public/ would silently reopen both holes, so the invariant is pinned here.
 *
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  PUBLIC_ROOT,
  PUBLIC_UPLOADS_ROOT,
  PUBLIC_VIDEOS_ROOT,
  PRIVATE_ROOT,
  CHUNK_ROOT,
  RAW_VIDEOS_ROOT,
  isInside,
} from "./upload-storage.ts";

test("private roots live outside the whole served public/ tree", () => {
  // PUBLIC_ROOT — not PUBLIC_UPLOADS_ROOT. Next.js serves everything under
  // public/ at the URL root, so a private root at <cwd>/public/private would
  // be web-reachable while still passing an uploads-only containment check.
  assert.equal(isInside(PUBLIC_ROOT, PRIVATE_ROOT), false);
  assert.equal(isInside(PUBLIC_ROOT, CHUNK_ROOT), false);
  assert.equal(isInside(PUBLIC_ROOT, RAW_VIDEOS_ROOT), false);
});

test("private roots live outside the publicly served uploads root", () => {
  assert.equal(isInside(PUBLIC_UPLOADS_ROOT, CHUNK_ROOT), false);
  assert.equal(isInside(PUBLIC_UPLOADS_ROOT, RAW_VIDEOS_ROOT), false);
});

test("private roots are inside the private root", () => {
  assert.equal(isInside(PRIVATE_ROOT, CHUNK_ROOT), true);
  assert.equal(isInside(PRIVATE_ROOT, RAW_VIDEOS_ROOT), true);
});

test("chunk staging and raw videos are distinct directories", () => {
  assert.notEqual(CHUNK_ROOT, RAW_VIDEOS_ROOT);
});

test("isInside rejects prefix-sibling confusion", () => {
  // "/public/uploads-evil" must not count as inside "/public/uploads".
  assert.equal(isInside("/public/uploads", "/public/uploads-evil/x"), false);
  assert.equal(isInside("/public/uploads", "/public/uploads"), true);
  assert.equal(isInside("/public/uploads", "/public/uploads/a/b"), true);
});

test("isInside actually detects containment", () => {
  // Guards against a broken helper making every assertion above vacuously
  // true: the public roots must report as inside PUBLIC_ROOT.
  assert.equal(isInside(PUBLIC_ROOT, PUBLIC_UPLOADS_ROOT), true);
  assert.equal(isInside(PUBLIC_ROOT, PUBLIC_VIDEOS_ROOT), true);
});

test("roots are absolute and rooted at the working directory", () => {
  assert.ok(path.isAbsolute(PUBLIC_UPLOADS_ROOT));
  assert.ok(path.isAbsolute(PRIVATE_ROOT));
  assert.equal(path.basename(RAW_VIDEOS_ROOT), "videos-raw");
  assert.equal(path.basename(CHUNK_ROOT), "uploads-tmp");
});

// ── Deployment wiring ──────────────────────────────────────────────────
// The compose mounts are the only thing that makes the private tier both
// unreachable AND persistent. Their container-side targets are hardcoded
// strings that must equal the paths the code writes to — a typo there puts
// the originals back in the container's writable layer, where they are
// destroyed on every recreate. Nothing else in the repo would catch that.
const CONTAINER_CWD = "/app";

function containerPathFor(root: string): string {
  return path.join(CONTAINER_CWD, path.relative(process.cwd(), root));
}

test("compose mounts the private roots exactly where the code writes them", () => {
  const compose = readFileSync(path.join(process.cwd(), "docker-compose.yml"), "utf8");
  for (const root of [CHUNK_ROOT, RAW_VIDEOS_ROOT]) {
    const expected = containerPathFor(root);
    assert.ok(
      compose.includes(`:${expected}`),
      `docker-compose.yml must mount the private root at ${expected}`,
    );
  }
});

test("compose keeps the private tier out of the served public/ tree", () => {
  const compose = readFileSync(path.join(process.cwd(), "docker-compose.yml"), "utf8");
  // Every container-side mount target, e.g. "./uploads/forum:/app/public/uploads/forum".
  const targets = [...compose.matchAll(/:\/app\/[^\s'"]+/g)].map((m) => m[0].slice(1));
  assert.ok(targets.length > 0, "expected compose mount targets");
  for (const target of targets) {
    assert.equal(
      target.startsWith(`${containerPathFor(PUBLIC_ROOT)}/private`),
      false,
      `${target} puts the private tier inside the served public/ tree`,
    );
  }
});
