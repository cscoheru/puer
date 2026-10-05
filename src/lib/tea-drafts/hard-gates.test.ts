/**
 * Tests for hard-gates.ts (fail-closed eligibility).
 *
 * Run: node --test --test-reporter=spec src/lib/tea-drafts/hard-gates.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHardGates, MIN_SAFE_TEXT_CODEPOINTS, type HardGateConfig } from "./hard-gates.ts";

const CONFIG: HardGateConfig = {
  authorId: "auth-1",
  noteIds: new Set(["note-1"]),
};
const PASS_CTX = { activeUsersExist: true, existingDraftExists: false, teaAlreadyCovered: false };

// Build content whose extracted plain text is exactly `n` code points.
function textOf(n: number): string {
  return "<p>" + "字".repeat(n) + "</p>";
}

const GOOD_NOTE = {
  id: "note-1",
  authorId: "auth-1",
  source: "manual",
  title: "标题",
  content: textOf(MIN_SAFE_TEXT_CODEPOINTS),
  teaId: "tea-1",
};

test("passes when every gate is satisfied", () => {
  assert.deepEqual(checkHardGates(GOOD_NOTE, CONFIG, PASS_CTX), { pass: true });
});

test("accepts both manual and evernote sources", () => {
  for (const source of ["manual", "evernote"]) {
    const r = checkHardGates({ ...GOOD_NOTE, source }, CONFIG, PASS_CTX);
    assert.equal(r.pass, true, `expected source=${source} to pass`);
  }
});

test("rejects unknown source", () => {
  const r = checkHardGates({ ...GOOD_NOTE, source: "import" }, CONFIG, PASS_CTX);
  assert.equal(r.pass, false);
  assert.equal(r.reason, "source_not_manual");
});

test("R31: different author passes (author identity gate removed)", () => {
  const r = checkHardGates({ ...GOOD_NOTE, authorId: "someone-else" }, CONFIG, PASS_CTX);
  assert.equal(r.pass, true);
});

test("rejects when note id is not in a non-empty allowlist", () => {
  const r = checkHardGates({ ...GOOD_NOTE, id: "note-2" }, CONFIG, PASS_CTX);
  assert.equal(r.reason, "note_not_in_allowlist");
});

test("empty allowlist = wildcard: any note id passes", () => {
  const wildcard: HardGateConfig = { authorId: "auth-1", noteIds: new Set() };
  const r = checkHardGates({ ...GOOD_NOTE, id: "any-note" }, wildcard, PASS_CTX);
  assert.equal(r.pass, true);
});

test("rejects when no active users exist in pool (DB fact)", () => {
  const r = checkHardGates(GOOD_NOTE, CONFIG, { ...PASS_CTX, activeUsersExist: false });
  assert.equal(r.reason, "author_inactive_or_banned");
});

test("rejects when a draft already exists for this note (idempotency)", () => {
  const r = checkHardGates(GOOD_NOTE, CONFIG, { ...PASS_CTX, existingDraftExists: true });
  assert.equal(r.reason, "draft_already_exists");
});

test("rejects when the tea is already covered by another draft (tea-level dedup)", () => {
  const r = checkHardGates(GOOD_NOTE, CONFIG, { ...PASS_CTX, teaAlreadyCovered: true });
  assert.equal(r.pass, false);
  assert.equal(r.reason, "tea_already_covered");
});

test("rejects empty title", () => {
  const r = checkHardGates({ ...GOOD_NOTE, title: "   " }, CONFIG, PASS_CTX);
  assert.equal(r.reason, "empty_title");
});

test("content length boundary: exactly MIN passes, MIN-1 fails", () => {
  const atMin = checkHardGates({ ...GOOD_NOTE, content: textOf(MIN_SAFE_TEXT_CODEPOINTS) }, CONFIG, PASS_CTX);
  assert.equal(atMin.pass, true);
  const below = checkHardGates({ ...GOOD_NOTE, content: textOf(MIN_SAFE_TEXT_CODEPOINTS - 1) }, CONFIG, PASS_CTX);
  assert.equal(below.pass, false);
  assert.equal(below.reason, "content_too_short");
});

test("rejects disqualifying repost/source/copyright signals", () => {
  for (const signal of ["转发请注明", "原文地址：http://x", "来源：网络", "版权归原作者所有", "本文转自他处"]) {
    const r = checkHardGates({ ...GOOD_NOTE, content: `<p>${signal}${"字".repeat(80)}</p>` }, CONFIG, PASS_CTX);
    assert.equal(r.pass, false, `expected signal to disqualify: ${signal}`);
    assert.equal(r.reason, "disqualifying_signal");
  }
});

test("DB-backed gates run before content parsing (no active users short-circuits)", () => {
  // Even with empty content that would fail length, no active users reports the
  // author reason — proving order is pool-check before content-check.
  const r = checkHardGates(
    { ...GOOD_NOTE, content: "" },
    CONFIG,
    { ...PASS_CTX, activeUsersExist: false },
  );
  assert.equal(r.reason, "author_inactive_or_banned");
});