/**
 * Tests for id.ts (deterministic draft id).
 *
 * Run: node --test --test-reporter=spec src/lib/tea-drafts/id.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tastingDraftId, isTastingDraftId, noteIdFromDraftId } from "./id.ts";

const GOOD = "cjld2cjxh0000qzrmn831i7rn"; // 24-char lowercase cuid
const UUID = "03c897f9-ff93-493f-a367-9f39ffb132dd"; // evernote-imported note id

test("tastingDraftId: builds prefix:id", () => {
  assert.equal(tastingDraftId(GOOD), "tasting-draft_" + GOOD);
});

test("tastingDraftId: accepts UUID-style note ids (evernote imports)", () => {
  assert.equal(tastingDraftId(UUID), "tasting-draft_" + UUID);
  assert.equal(noteIdFromDraftId("tasting-draft_" + UUID), UUID);
});

test("tastingDraftId: rejects malformed noteId (no silent draft)", () => {
  assert.throws(() => tastingDraftId(""), /Invalid noteId/);
  assert.throws(() => tastingDraftId("has:colon"), /Invalid noteId/);
  assert.throws(() => tastingDraftId("has/slash"), /Invalid noteId/);
  assert.throws(() => tastingDraftId("UPPER123"), /Invalid noteId/); // cuid is lowercase
  assert.throws(() => tastingDraftId("short"), /Invalid noteId/); // < 16 chars
  assert.throws(() => tastingDraftId("sym!@#$%"), /Invalid noteId/);
});

test("isTastingDraftId: true for the prefix regardless of suffix validity", () => {
  assert.equal(isTastingDraftId("tasting-draft_" + GOOD), true);
  assert.equal(isTastingDraftId("tasting-draft_whatever"), true);
  assert.equal(isTastingDraftId("plainid"), false);
  assert.equal(isTastingDraftId("tastingdraft:" + GOOD), false);
});

test("noteIdFromDraftId: round-trips a valid draft id", () => {
  const id = tastingDraftId(GOOD);
  assert.equal(noteIdFromDraftId(id), GOOD);
});

test("noteIdFromDraftId: null for non-prefix or invalid suffix", () => {
  assert.equal(noteIdFromDraftId("plainid"), null);
  assert.equal(noteIdFromDraftId("tasting-draft_bogus!"), null);
  assert.equal(noteIdFromDraftId("tasting-draft_"), null);
});
