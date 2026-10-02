/**
 * Tests for hot-rank.ts — the ranking primitives shared by the board page and
 * the home feed.
 *
 * Run: node --test --test-reporter=spec src/lib/hot-rank.test.ts
 *
 * The property these tests exist for is not the arithmetic, which is short
 * enough to read at a glance. It is the *relationship* between the two scores:
 *
 *   _hotScore  — the ranking. Not personal. Every reader gets the same one.
 *   _finalScore — a per-reader *view* of that ranking.
 *
 * Confusing the two is how you end up with a feed that only ever shows a reader
 * what they already saw, so most of what follows pins that distinction down.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreThread,
  jitterSeed,
  jitterAmount,
  tierFactor,
  applyHotRank,
  type HotRankInputs,
} from "./hot-rank.ts";

const NOW = 1_700_000_000_000; // fixed, so nothing depends on the wall clock
const HOUR = 3_600_000;

function thread(over: Partial<HotRankInputs>): HotRankInputs {
  return {
    id: "t1",
    upvotes: 10,
    downvotes: 0,
    replyCount: 3,
    viewCount: 100,
    hasMedia: false,
    createdAt: new Date(NOW - 24 * HOUR),
    lastRepliedAt: null,
    ...over,
  };
}

// ─── scoreThread ───────────────────────────────────────────────────────────

test("scoreThread: golden value pins the formula constants", () => {
  // Every other test in this file is relational — ratios, inequalities — so all
  // of them pass if a constant is mistyped during extraction. `* 6` → `* 0.6`
  // still satisfies every media/age/vote assertion below; this is the only
  // assertion that notices. The literal is hand-computed from the fixture in
  // `thread()`:
  //   ln(11)*6 + ln(4)*4 + ln(101)*0.2 = 20.855573184638040
  //   × 1 (no media) × (1 + 0.3/(1 + 24/48)) = × 1.2
  //   = 25.026687821565648
  // Tune the formula deliberately and you update this one literal — the diff
  // then shows up in review as a number change rather than hiding in a ratio.
  const golden = 25.02668782156565;
  assert.ok(
    Math.abs(scoreThread(thread({}), NOW) - golden) < 1e-9,
    `scoreThread drifted: ${scoreThread(thread({}), NOW)} != ${golden}`,
  );
});

test("scoreThread: a media post scores 1.3× the identical post without media", () => {
  const plain = scoreThread(thread({}), NOW);
  const withMedia = scoreThread(thread({ hasMedia: true }), NOW);
  assert.ok(Math.abs(withMedia - plain * 1.3) < 1e-9);
});

test("scoreThread: net votes floor at 0 — a downvoted post is not scored negatively", () => {
  const buried = scoreThread(thread({ upvotes: 0, downvotes: 50 }), NOW);
  const neutral = scoreThread(thread({ upvotes: 0, downvotes: 0 }), NOW);
  assert.equal(buried, neutral);
});

test("scoreThread: time only ever adds, and the bonus is capped by the 720h age clamp", () => {
  const brandNew = scoreThread(thread({ createdAt: new Date(NOW), lastRepliedAt: null }), NOW);
  const stale = scoreThread(thread({ createdAt: new Date(NOW - 10_000 * HOUR), lastRepliedAt: null }), NOW);
  const atClamp = scoreThread(thread({ createdAt: new Date(NOW - 720 * HOUR), lastRepliedAt: null }), NOW);

  assert.ok(brandNew > stale, "a newer post must outrank an otherwise identical stale one");
  assert.ok(stale > 0, "time decays the bonus toward 1, never toward 0");
  // Past the clamp every post is equally old, so the bonus stops moving.
  assert.equal(
    scoreThread(thread({ createdAt: new Date(NOW - 5_000 * HOUR), lastRepliedAt: null }), NOW),
    atClamp,
  );
});

test("scoreThread: future-dated rows hit a pole at age −48h — PRE-EXISTING, pinned not fixed", () => {
  // The 720h clamp is top-only (`Math.min`), so a row dated in the future gets a
  // NEGATIVE age. `1 + 0.3/(1 + age/48)` then walks past a pole at age = −48h:
  //
  //   +47h  →  timeBonus 15.4        (a 12× boost over a present-day row)
  //   +48h  →  Infinity              (sorts to the top of every board, forever)
  //   +48.0001h → ≈ −3e6             (sorts below every dead thread)
  //   +60h  →  −0.2                  (score is negative)
  //
  // This predates the extraction — the formula is byte-identical to the inline
  // version it replaced, and this cut's contract is zero behaviour change. So it
  // is pinned here as *current* behaviour rather than repaired: a one-line
  // `Math.max(0, …)` would fix it, but that is a ranking change and needs its own
  // sign-off. Asserted so nobody "tidies" the clamp without seeing this window.
  const scoreAt = (hoursAhead: number) =>
    scoreThread(thread({ createdAt: new Date(NOW + hoursAhead * HOUR) }), NOW);

  assert.ok(scoreAt(47) > scoreAt(0) * 10, "a near-pole future date dominates the ranking");
  assert.equal(scoreAt(48), Infinity);
  assert.ok(scoreAt(48.0001) < -1e6, "just past the pole the score collapses to a large negative");
  assert.ok(scoreAt(60) < 0, "a future-dated row can score below a dead one");
});

test("scoreThread: a fresh reply refreshes the post — age comes from lastRepliedAt first", () => {
  const oldButReplied = scoreThread(
    thread({ createdAt: new Date(NOW - 500 * HOUR), lastRepliedAt: new Date(NOW - 1 * HOUR) }),
    NOW,
  );
  const oldAndQuiet = scoreThread(
    thread({ createdAt: new Date(NOW - 500 * HOUR), lastRepliedAt: null }),
    NOW,
  );
  assert.ok(oldButReplied > oldAndQuiet);
});

test("scoreThread: view count is capped at 1000 so a viral hit cannot dominate", () => {
  const atCap = scoreThread(thread({ viewCount: 1000 }), NOW);
  const pastCap = scoreThread(thread({ viewCount: 999_999 }), NOW);
  assert.equal(atCap, pastCap);
});

// ─── jitter primitives ─────────────────────────────────────────────────────

test("jitterSeed: same user and bucket agree; either changing reshuffles", () => {
  assert.equal(jitterSeed("u1", 7), jitterSeed("u1", 7));
  assert.notEqual(jitterSeed("u1", 7), jitterSeed("u2", 7));
  assert.notEqual(jitterSeed("u1", 7), jitterSeed("u1", 8));
  // An anonymous reader is a reader of their own, not an error path.
  assert.equal(jitterSeed(undefined, 7), jitterSeed(undefined, 7));
  assert.notEqual(jitterSeed(undefined, 7), jitterSeed("u1", 7));
});

test("jitterAmount: deterministic in (id, seed), and bounded to [0, 0.40]", () => {
  assert.equal(jitterAmount("abc", 42), jitterAmount("abc", 42));
  // Different seeds must actually differ, else the per-reader shuffle is a no-op.
  assert.notEqual(jitterAmount("abc", 42), jitterAmount("abc", 43));
  for (let i = 0; i < 200; i++) {
    const v = jitterAmount("id-" + i, i * 17);
    assert.ok(v >= 0 && v <= 0.4, `jitter ${v} out of range`);
  }
});

test("tierFactor: top 5 full strength, next 10 at 60%, the rest at 30%", () => {
  assert.equal(tierFactor(0, 5), 1.0);
  assert.equal(tierFactor(4, 5), 1.0);
  assert.equal(tierFactor(5, 5), 0.6);
  assert.equal(tierFactor(14, 5), 0.6);
  assert.equal(tierFactor(15, 5), 0.3);
});

test("tierFactor: topN is the tier boundary, not a hard list of 5", () => {
  assert.equal(tierFactor(2, 3), 1.0);
  assert.equal(tierFactor(3, 3), 0.6);
  assert.equal(tierFactor(0, 0), 0.6); // empty list: nothing is in the top tier
});

// ─── applyHotRank ──────────────────────────────────────────────────────────

/**
 * 20 threads whose `_hotScore` values are strictly decreasing but separated by
 * only ~0.03% each (`log1p(100)` vs `log1p(99)`), while the per-row jitter runs
 * up to 40%. Any pairing of adjacent rows is therefore crossing-prone, so the
 * returned order is *guaranteed* to differ from the `_hotScore` order — which
 * is the precondition the tier-index test below depends on. With evenly spaced
 * scores the two orders would never diverge and that assertion would pass
 * vacuously.
 */
function ladder(): HotRankInputs[] {
  return Array.from({ length: 20 }, (_, i) =>
    thread({ id: `t${String(i).padStart(2, "0")}`, upvotes: 100 - i }),
  );
}

/** The `_hotScore` order, recovered independently of `applyHotRank`'s sort. */
function hotOrder<T extends { id: string; _hotScore: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b._hotScore - a._hotScore);
}

test("applyHotRank: _hotScore is reader-invariant — the ranking is not personal", () => {
  const rows = ladder();
  const alice = applyHotRank(rows, { now: NOW, bucket: 1, sessionUserId: "alice" });
  const bob = applyHotRank(rows, { now: NOW, bucket: 1, sessionUserId: "bob" });

  // Per-row base scores are identical across readers…
  for (const a of alice) {
    assert.equal(a._hotScore, bob.find((b) => b.id === a.id)?._hotScore);
  }
  // …and so is the ordering those scores produce.
  assert.deepEqual(hotOrder(alice).map((r) => r.id), hotOrder(bob).map((r) => r.id));

  // The *returned* order is the personal part and may differ. With 20 rows and
  // 40% jitter it does; asserting that here documents which order is allowed to
  // vary, so a later edit that personalises `_hotScore` fails loudly.
  assert.notDeepEqual(alice.map((r) => r.id), bob.map((r) => r.id));
});

test("applyHotRank: the tier coefficient comes from the _hotScore rank, not the jittered rank", () => {
  const rows = ladder();
  const ranked = applyHotRank(rows, { now: NOW, bucket: 3, sessionUserId: "carol" });

  // Precondition: the jitter actually moved things, otherwise this test proves
  // nothing. (The ladder is built to guarantee it; see above.)
  assert.notDeepEqual(ranked.map((r) => r.id), hotOrder(ranked).map((r) => r.id));

  const seed = jitterSeed("carol", 3);
  const topN = Math.min(5, ranked.length);
  const byHotIndex = new Map(hotOrder(ranked).map((r, i) => [r.id, i]));

  for (const r of ranked) {
    const hotIndex = byHotIndex.get(r.id);
    assert.notEqual(hotIndex, undefined);
    // tierFactor is fed `hotIndex` — the position in the _hotScore ordering.
    // Feeding the jittered position back in is a self-reinforcing loop: a row
    // that jitter happens to lift keeps drawing the full-strength coefficient
    // and stays lifted. This assertion is what catches that.
    const expected = r._hotScore * (1 + jitterAmount(r.id, seed) * tierFactor(hotIndex!, topN));
    assert.ok(
      Math.abs(r._finalScore - expected) < 1e-9,
      `row ${r.id} (hot rank ${hotIndex}) got ${r._finalScore}, expected ${expected}`,
    );
  }
});

test("applyHotRank: the returned order is exactly the _finalScore order", () => {
  const ranked = applyHotRank(ladder(), { now: NOW, bucket: 5 });
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1]._finalScore >= ranked[i]._finalScore);
  }
});

test("applyHotRank: injected now/bucket make it fully reproducible", () => {
  const rows = ladder();
  const a = applyHotRank(rows, { now: NOW, bucket: 2, sessionUserId: "dave" });
  const b = applyHotRank(rows, { now: NOW, bucket: 2, sessionUserId: "dave" });
  assert.deepEqual(
    a.map((r) => [r.id, r._hotScore, r._finalScore]),
    b.map((r) => [r.id, r._hotScore, r._finalScore]),
  );
});

test("applyHotRank: a different bucket reshuffles the personal view but not the base scores", () => {
  const rows = ladder();
  const day1 = applyHotRank(rows, { now: NOW, bucket: 1, sessionUserId: "erin" });
  const day2 = applyHotRank(rows, { now: NOW, bucket: 2, sessionUserId: "erin" });

  assert.deepEqual(hotOrder(day1).map((r) => r.id), hotOrder(day2).map((r) => r.id));
  assert.notDeepEqual(day1.map((r) => r.id), day2.map((r) => r.id));
});

test("applyHotRank: `now` is the clock — advancing it changes nothing but the age bonus", () => {
  const rows = ladder();
  const t0 = applyHotRank(rows, { now: NOW, bucket: 1, sessionUserId: "frank" });
  const t1 = applyHotRank(rows, { now: NOW + 24 * HOUR, bucket: 1, sessionUserId: "frank" });
  // Same seed (same user, same bucket) ⇒ same per-row jitter ⇒ same personal
  // ordering, as long as the age bonus does not change the relative ranking.
  assert.deepEqual(t0.map((r) => r.id), t1.map((r) => r.id));
  for (const r of t1) {
    assert.ok(r._hotScore < t0.find((x) => x.id === r.id)!._hotScore, "age only ever adds");
  }
});

test("applyHotRank: does not mutate its input", () => {
  const rows = ladder();
  const snapshot = rows.map((r) => ({ ...r }));
  applyHotRank(rows, { now: NOW, bucket: 1, sessionUserId: "grace" });
  assert.deepEqual(rows, snapshot);
});

test("applyHotRank: an empty list is a valid result, not a crash", () => {
  assert.deepEqual(applyHotRank([], { now: NOW, bucket: 1 }), []);
});

test("applyHotRank: a single thread keeps its score; jitter runs at full tier strength", () => {
  // `tierFactor(0, 1)` is 1.0, so the jitter IS applied — it simply cannot
  // reorder a one-element list. Pinned to the exact value so neither reading of
  // this path can drift silently.
  const t = thread({ id: "solo" });
  const [only] = applyHotRank([t], { now: NOW, bucket: 1, sessionUserId: "h" });
  assert.equal(only.id, "solo");
  assert.equal(only._hotScore, scoreThread(t, NOW));
  const expected = only._hotScore * (1 + jitterAmount("solo", jitterSeed("h", 1)) * 1.0);
  assert.ok(Math.abs(only._finalScore - expected) < 1e-12, `${only._finalScore} != ${expected}`);
  // Top tier with a 0..0.40 jitter ⇒ the final score is never below the base.
  assert.ok(only._finalScore >= only._hotScore);
});
