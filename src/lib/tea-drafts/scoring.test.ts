/**
 * Tests for scoring.ts (fixed score table + stable rank).
 *
 * Run: node --test --test-reporter=spec src/lib/tea-drafts/scoring.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreCandidate, rankCandidates, SCORE_THRESHOLD, type ScoringInput } from "./scoring.ts";

const NO_RECENT = { recentAutoDraftTeaId: null };

function base(over: Partial<ScoringInput>): ScoringInput {
  return {
    id: "n1",
    createdAt: 1000,
    content: "<p>x</p>",
    teaId: "tea-1",
    brewParams: { brewMethod: null, waterTemp: null, teaWeight: null, steepCount: null },
    imageCount: 0,
    videoUrl: null,
    ...over,
  };
}
// HTML whose extracted plain text is exactly `n` code points long.
const text = (n: number) => "<p>" + "字".repeat(n) + "</p>";

test("SCORE_THRESHOLD is 2", () => {
  assert.equal(SCORE_THRESHOLD, 2);
});

test("content length bands: 80→1, 200→2, 800→3", () => {
  assert.equal(scoreCandidate(base({ content: text(80) }), NO_RECENT).score, 1);
  assert.equal(scoreCandidate(base({ content: text(200) }), NO_RECENT).score, 2);
  assert.equal(scoreCandidate(base({ content: text(800) }), NO_RECENT).score, 3);
  // boundary: 79 → 0
  assert.equal(scoreCandidate(base({ content: text(79) }), NO_RECENT).score, 0);
});

test("≥2 non-empty brew params → +1; only 1 → +0", () => {
  const two = base({
    content: text(80),
    brewParams: { brewMethod: "盖碗", waterTemp: 95, teaWeight: null, steepCount: null },
  });
  const one = base({
    content: text(80),
    brewParams: { brewMethod: "盖碗", waterTemp: null, teaWeight: null, steepCount: null },
  });
  assert.equal(scoreCandidate(two, NO_RECENT).score, 2); // 1 (text) + 1 (params)
  assert.equal(scoreCandidate(one, NO_RECENT).score, 1); // 1 (text) + 0
});

test("≥4 validated images → +1; 3 → +0", () => {
  assert.equal(scoreCandidate(base({ content: text(80), imageCount: 4 }), NO_RECENT).score, 2);
  assert.equal(scoreCandidate(base({ content: text(80), imageCount: 3 }), NO_RECENT).score, 1);
});

test("valid videoUrl → +1; null → +0", () => {
  assert.equal(
    scoreCandidate(base({ content: text(80), videoUrl: "https://x/v.mp4" }), NO_RECENT).score,
    2,
  );
  assert.equal(scoreCandidate(base({ content: text(80) }), NO_RECENT).score, 1);
});

test("same teaId as most-recent auto-draft → −1 penalty", () => {
  const ctx = { recentAutoDraftTeaId: "tea-1" };
  assert.equal(scoreCandidate(base({ content: text(80), teaId: "tea-1" }), ctx).score, 0); // 1 - 1
  // Different teaId is unaffected.
  assert.equal(scoreCandidate(base({ content: text(80), teaId: "tea-2" }), ctx).score, 1);
});

test("subjective scoring fields do NOT participate (no input for them)", () => {
  // ScoringInput has no appearance/color/aroma/... fields at all — confirmed by
  // construction. A note's taste score cannot influence selection.
  const s = scoreCandidate(base({ content: text(800) }), NO_RECENT);
  assert.equal(s.score, 3); // only the content band
});

test("rankCandidates: score DESC, then createdAt DESC, then id ASC", () => {
  const ranked = rankCandidates([
    { id: "c", score: 2, createdAt: 100 },
    { id: "a", score: 3, createdAt: 50 },
    { id: "b", score: 2, createdAt: 200 }, // same score as c, newer → first
    { id: "d", score: 2, createdAt: 200 }, // same score+createdAt as b → id ASC
  ]);
  assert.deepEqual(
    ranked.map((r) => r.id),
    ["a", "b", "d", "c"],
  );
});

test("rankCandidates does not mutate the input", () => {
  const input = [
    { id: "b", score: 1, createdAt: 0 },
    { id: "a", score: 2, createdAt: 0 },
  ];
  rankCandidates(input);
  assert.deepEqual(input.map((r) => r.id), ["b", "a"]); // unchanged
});
