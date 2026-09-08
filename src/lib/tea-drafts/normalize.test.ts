/**
 * Tests for normalize.ts (TastingNote → NormalizedNote projection).
 *
 * Run: node --test --test-reporter=spec src/lib/tea-drafts/normalize.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTastingNote, type TastingNoteLike } from "./normalize.ts";

const BASE: TastingNoteLike = {
  id: "n1",
  title: "标题",
  content: "<p>正文</p>",
  summary: "摘要",
  teaId: "tea-1",
  authorId: "auth-1",
  source: "manual",
  brewMethod: "盖碗",
  waterTemp: 95,
  teaWeight: "5g",
  steepCount: 8,
  images: ["https://x/y.jpg"],
  videoUrl: "https://x/v.mp4",
  createdAt: 1_700_000_000_000,
};

test("copies fields verbatim and does not rewrite content", () => {
  const n = normalizeTastingNote(BASE);
  assert.equal(n.id, "n1");
  assert.equal(n.content, "<p>正文</p>"); // raw HTML preserved
  assert.equal(n.summary, "摘要");
  assert.equal(n.teaId, "tea-1");
  assert.equal(n.brewMethod, "盖碗");
  assert.deepEqual(n.images, ["https://x/y.jpg"]);
});

test("defaults nullable fields to null when absent", () => {
  const n = normalizeTastingNote({
    id: "n2",
    title: "t",
    content: "c",
    teaId: "t",
    authorId: "a",
    source: "evernote",
    createdAt: 0,
  });
  assert.equal(n.summary, null);
  assert.equal(n.brewMethod, null);
  assert.equal(n.waterTemp, null);
  assert.equal(n.teaWeight, null);
  assert.equal(n.steepCount, null);
  assert.equal(n.images, null);
  assert.equal(n.videoUrl, null);
});

test("coerces createdAt from Date / ISO string / number to epoch ms", () => {
  const date = new Date("2024-01-15T00:00:00Z");
  const iso = "2024-01-15T00:00:00Z";
  const expected = date.getTime();
  assert.equal(
    normalizeTastingNote({ ...BASE, createdAt: date }).createdAt,
    expected,
  );
  assert.equal(
    normalizeTastingNote({ ...BASE, createdAt: iso }).createdAt,
    expected,
  );
  assert.equal(
    normalizeTastingNote({ ...BASE, createdAt: expected }).createdAt,
    expected,
  );
});
