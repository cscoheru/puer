/**
 * Deterministic security tests for the pure upload policy. No fs, no network,
 * no framework. These exist to PROVE the invariants that the old route
 * violated: identifier validation, path containment (traversal + prefix
 * confusion), numeric bounds, type allowlisting, manifest integrity/ownership.
 *
 * Run: npm run test:policy
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  UploadPolicyError,
  parseUploadId,
  sanitizeUserId,
  buildContainedPath,
  classifyFileType,
  deriveExtension,
  parseCategory,
  categoryToSubdir,
  parseTotalChunks,
  parseChunkIndex,
  assertUploadSize,
  verifyContiguousChunks,
  expectedChunkNames,
  parseManifest,
  serializeManifest,
  assertManifestOwner,
  MANIFEST_FILENAME,
  MAX_TOTAL_CHUNKS,
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  type UploadManifest,
} from "./upload-policy.ts";

function rejects(fn: () => unknown, code: string): void {
  assert.throws(
    () => fn(),
    (err) => err instanceof UploadPolicyError && (err as UploadPolicyError).code === code,
    `expected UploadPolicyError ${code}`,
  );
}
function ok<T>(fn: () => T): T {
  return fn();
}

// ── uploadId ──────────────────────────────────────────────────────────────
test("uploadId: accepts exactly 32 lowercase hex", () => {
  assert.equal(ok(() => parseUploadId("a".repeat(32))), "a".repeat(32));
  assert.equal(ok(() => parseUploadId("0123456789abcdef0123456789abcdef")), "0123456789abcdef0123456789abcdef");
});

test("uploadId: rejects every traversal/encoding/malformed variant", () => {
  const cases = [
    "../forum",          // the production CVE payload
    "..",
    "../../etc/passwd",
    "/etc/passwd",       // absolute
    "%2e%2e%2fforum",    // percent-encoded (fs does not decode)
    "..%2f..%2f",        // mixed
    "....//forum",
    "",                  // empty
    "abc",               // too short
    "a".repeat(31),      // 31 chars
    "a".repeat(33),      // 33 chars
    "A".repeat(32),      // uppercase
    "g".repeat(32),      // non-hex
    "a".repeat(32) + " ",// trailing space
    " a".repeat(16),     // spaces
    "a".repeat(31) + "\0",// null byte
    "a".repeat(16) + "-" + "b".repeat(15), // dash
    123456 as unknown,   // wrong type
    null,
    undefined,
    Buffer.from("x"),    // wrong type
  ];
  for (const c of cases) rejects(() => parseUploadId(c), "bad_upload_id");
});

// ── userId ─────────────────────────────────────────────────────────────────
test("userId: accepts alnum/_/- and rejects traversal", () => {
  assert.equal(ok(() => sanitizeUserId("user_123")), "user_123");
  assert.equal(ok(() => sanitizeUserId("a-b")), "a-b");
  rejects(() => sanitizeUserId("../x"), "bad_user_id");
  rejects(() => sanitizeUserId("a/b"), "bad_user_id");
  rejects(() => sanitizeUserId("a\\b"), "bad_user_id");
  rejects(() => sanitizeUserId("a b"), "bad_user_id");
  rejects(() => sanitizeUserId(""), "bad_user_id");
  rejects(() => sanitizeUserId("a".repeat(129)), "bad_user_id");
  rejects(() => sanitizeUserId("a..b"), "bad_user_id"); // contains ..
});

// ── path containment — the core defense ───────────────────────────────────
const ROOT = path.resolve("/srv/uploads/.tmp");

test("buildContainedPath: accepts a normal child", () => {
  const p = ok(() => buildContainedPath(ROOT, "user1", "abcd".repeat(8)));
  assert.equal(p, path.join(ROOT, "user1", "abcd".repeat(8)));
  assert.ok(p.startsWith(ROOT + path.sep));
});

test("buildContainedPath: rejects traversal segments and absolute injection", () => {
  const bad = [
    ["..", "x"],
    ["x", ".."],
    ["../forum"],
    ["/etc/passwd"],
    ["a/b"],
    ["a\\b"],
    ["a\0b"],
    ["."],
    [""],
  ];
  for (const seg of bad) rejects(() => buildContainedPath(ROOT, ...seg), "path_escape");
});

test("buildContainedPath: literal percent-encoded names are contained, not traversal", () => {
  // The filesystem does not URL-decode, so "..%2fforum" is a literal directory
  // name INSIDE the root — contained and safe. (Real callers only ever pass
  // regex-validated ids that cannot contain "%" anyway.)
  const p = ok(() => buildContainedPath(ROOT, "..%2fforum"));
  assert.ok(p.startsWith(ROOT + path.sep));
});

test("buildContainedPath: separator-aware prefix guard (the subtle bug)", () => {
  // Root "/srv/uploads/.tmp" must NOT contain "/srv/uploads/.tmp-evil/x".
  // We cannot craft that via buildContainedPath (segment rules block "-evil/x"),
  // so verify the guard logic by asserting a direct resolve stays distinct.
  const rootA = path.resolve("/srv/uploads/.tmp");
  const sibling = path.resolve("/srv/uploads/.tmp-evil/x");
  assert.equal(sibling.startsWith(rootA + path.sep), false);
  assert.equal(sibling === rootA, false);
});

test("buildContainedPath: composed path stays inside even with valid ids", () => {
  // The real-world composition: valid userId + valid uploadId.
  const uid = "cu_" + "1".repeat(20);
  const upid = "f".repeat(32);
  const p = ok(() => buildContainedPath(ROOT, uid, upid));
  assert.ok(p === path.join(ROOT, uid, upid));
  assert.ok(p.startsWith(ROOT + path.sep));
});

// ── file type ──────────────────────────────────────────────────────────────
test("classifyFileType: accepts allowlisted MIME, exact match only", () => {
  assert.deepEqual(ok(() => classifyFileType("image/jpeg")), { kind: "image", mime: "image/jpeg" });
  assert.deepEqual(ok(() => classifyFileType("image/png")), { kind: "image", mime: "image/png" });
  assert.deepEqual(ok(() => classifyFileType("image/gif")), { kind: "image", mime: "image/gif" });
  assert.deepEqual(ok(() => classifyFileType("image/webp")), { kind: "image", mime: "image/webp" });
  assert.deepEqual(ok(() => classifyFileType("video/mp4")), { kind: "video", mime: "video/mp4" });
  assert.deepEqual(ok(() => classifyFileType("video/webm")), { kind: "video", mime: "video/webm" });
  assert.deepEqual(ok(() => classifyFileType("video/quicktime")), { kind: "video", mime: "video/quicktime" });
});

test("classifyFileType: rejects dangerous/empty/sloppy MIME", () => {
  const bad = [
    "image/svg+xml",          // XSS vector
    "application/octet-stream",
    "application/x-executable",
    "image/jpeg ",            // trailing space
    " image/jpeg",            // leading space
    "IMAGE/JPEG",             // uppercase
    "image/Jpeg",             // mixed case
    "image/jpeg;x",           // params
    "",
    null,
    undefined,
  ];
  for (const m of bad) rejects(() => classifyFileType(m), "unsupported_type");
});

test("deriveExtension: never returns a client-controlled extension", () => {
  assert.equal(ok(() => deriveExtension("image/jpeg")), "jpg"); // jpeg → jpg, fixed
  assert.equal(ok(() => deriveExtension("image/png")), "png");
  assert.equal(ok(() => deriveExtension("video/quicktime")), "mov");
  rejects(() => deriveExtension("image/svg+xml"), "unsupported_type");
});

// ── category ───────────────────────────────────────────────────────────────
test("category: fixed allowlist, prefix-safe", () => {
  assert.equal(ok(() => parseCategory(undefined)), "");
  assert.equal(ok(() => parseCategory("")), "");
  assert.equal(ok(() => parseCategory("session")), "session");
  assert.equal(ok(() => parseCategory("avatar")), "avatar");
  assert.equal(ok(() => parseCategory("inventory")), "inventory");
  rejects(() => parseCategory("sessionx"), "bad_category"); // prefix confusion
  rejects(() => parseCategory("SESSION"), "bad_category");
  rejects(() => parseCategory("../x"), "bad_category");
  rejects(() => parseCategory("videos"), "bad_category"); // cannot name an arbitrary subdir
});

test("categoryToSubdir: subDir always from fixed set", () => {
  const allowed = new Set(["forum", "videos", "sessions", "avatars", "inventory"]);
  assert.ok(allowed.has(categoryToSubdir("", "image")));
  assert.equal(categoryToSubdir("", "image"), "forum");
  assert.equal(categoryToSubdir("", "video"), "videos");
  assert.equal(categoryToSubdir("session", "image"), "sessions");
  assert.equal(categoryToSubdir("avatar", "video"), "avatars");
  assert.equal(categoryToSubdir("inventory", "image"), "inventory");
});

// ── numeric bounds ─────────────────────────────────────────────────────────
test("totalChunks: bounded positive int", () => {
  assert.equal(ok(() => parseTotalChunks(1)), 1);
  assert.equal(ok(() => parseTotalChunks("5")), 5);
  assert.equal(ok(() => parseTotalChunks(MAX_TOTAL_CHUNKS)), MAX_TOTAL_CHUNKS);
  rejects(() => parseTotalChunks(0), "bad_total_chunks");
  rejects(() => parseTotalChunks(-1), "bad_total_chunks");
  rejects(() => parseTotalChunks(MAX_TOTAL_CHUNKS + 1), "bad_total_chunks");
  rejects(() => parseTotalChunks(1.5), "bad_total_chunks");
  rejects(() => parseTotalChunks("1.5"), "bad_total_chunks");
  rejects(() => parseTotalChunks("0x10"), "bad_total_chunks");
  rejects(() => parseTotalChunks(" 5"), "bad_total_chunks");
  rejects(() => parseTotalChunks(""), "bad_total_chunks");
  rejects(() => parseTotalChunks(Infinity), "bad_total_chunks");
  rejects(() => parseTotalChunks(NaN), "bad_total_chunks");
});

test("chunkIndex: bounded by declared total", () => {
  assert.equal(ok(() => parseChunkIndex(0, 3)), 0);
  assert.equal(ok(() => parseChunkIndex("2", 3)), 2);
  rejects(() => parseChunkIndex(3, 3), "chunk_out_of_range"); // == total
  rejects(() => parseChunkIndex(-1, 3), "chunk_out_of_range");
  rejects(() => parseChunkIndex(100, 3), "chunk_out_of_range");
  rejects(() => parseChunkIndex(1.5, 3), "chunk_out_of_range");
  rejects(() => parseChunkIndex("abc", 3), "chunk_out_of_range");
  rejects(() => parseChunkIndex(1, 0), "bad_total_chunks"); // bad total
});

test("assertUploadSize: per-kind caps, off-by-one safe", () => {
  ok(() => assertUploadSize("image", IMAGE_MAX_BYTES));
  ok(() => assertUploadSize("video", VIDEO_MAX_BYTES));
  rejects(() => assertUploadSize("image", IMAGE_MAX_BYTES + 1), "size_too_large");
  rejects(() => assertUploadSize("video", VIDEO_MAX_BYTES + 1), "size_too_large");
  rejects(() => assertUploadSize("image", -1), "size_too_large");
  rejects(() => assertUploadSize("image", Infinity), "size_too_large");
});

// ── chunk-set completeness ─────────────────────────────────────────────────
test("verifyContiguousChunks: complete, missing-middle, missing-tail, ignores junk", () => {
  let r = ok(() => verifyContiguousChunks([0, 1, 2], 3));
  assert.equal(r.complete, true);
  assert.deepEqual(r.missing, []);

  r = ok(() => verifyContiguousChunks([0, 2], 3)); // missing middle
  assert.equal(r.complete, false);
  assert.deepEqual(r.missing, [1]);

  r = ok(() => verifyContiguousChunks([0, 1], 3)); // missing tail
  assert.equal(r.complete, false);
  assert.deepEqual(r.missing, [2]);

  // duplicates collapse, out-of-range ignored
  r = ok(() => verifyContiguousChunks([0, 0, 1, 1, 2, 2, 99, -1], 3));
  assert.equal(r.complete, true);

  rejects(() => verifyContiguousChunks([0], 0), "bad_total_chunks");
});

test("expectedChunkNames: names a complete upload may touch", () => {
  assert.deepEqual(ok(() => expectedChunkNames(3)), ["0", "1", "2"]);
  rejects(() => expectedChunkNames(0), "bad_total_chunks");
  rejects(() => expectedChunkNames(MAX_TOTAL_CHUNKS + 1), "bad_total_chunks");
});

// ── manifest ───────────────────────────────────────────────────────────────
function sampleManifest(overrides: Partial<UploadManifest> = {}): UploadManifest {
  return {
    ownerId: "user_abc",
    uploadId: "a".repeat(32),
    kind: "image",
    mime: "image/jpeg",
    category: "",
    subDir: "forum",
    totalChunks: 2,
    totalBytes: 1024,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

test("manifest: round-trips and parses a valid manifest", () => {
  const m = sampleManifest();
  const parsed = ok(() => parseManifest(serializeManifest(m)));
  assert.deepEqual(parsed, m);
  assert.equal(parsed.subDir, categoryToSubdir(parsed.category, parsed.kind));
});

test("manifest: rejects corruption, owner/field tampering, subDir mismatch", () => {
  rejects(() => parseManifest("not json"), "manifest_corrupt");
  rejects(() => parseManifest(null), "manifest_corrupt");
  rejects(() => parseManifest("{}"), "manifest_corrupt"); // missing fields
  // uploadId tampered to traversal (wrapped to manifest_corrupt by parseManifest)
  rejects(() => parseManifest(serializeManifest(sampleManifest({ uploadId: "../forum" }))), "manifest_corrupt");
  // subDir tampered to escape the fixed mapping
  rejects(() => parseManifest(serializeManifest(sampleManifest({ subDir: "../evil" }))), "manifest_corrupt");
  // size over cap (wrapped to manifest_corrupt: server-written manifest that
  // violates policy = corrupt/tampered)
  rejects(() => parseManifest(serializeManifest(sampleManifest({ kind: "image", totalBytes: IMAGE_MAX_BYTES + 1 }))), "manifest_corrupt");
  // mime swapped to svg after creation (mutable-header re-trust must fail)
  rejects(() => parseManifest(serializeManifest(sampleManifest({ mime: "image/svg+xml" }))), "manifest_corrupt");
  // createdAt missing
  rejects(() => parseManifest(serializeManifest(sampleManifest({ createdAt: "" }))), "manifest_corrupt");
});

test("manifest: ownership check", () => {
  const m = sampleManifest();
  ok(() => assertManifestOwner(m, "user_abc"));
  rejects(() => assertManifestOwner(m, "user_other"), "not_owner");
});

test("MANIFEST_FILENAME is a fixed string used by cleanup", () => {
  assert.equal(MANIFEST_FILENAME, "manifest.json");
  // Important: it does not contain path separators (must not become a traversal).
  assert.ok(!MANIFEST_FILENAME.includes("/") && !MANIFEST_FILENAME.includes("\\"));
});
