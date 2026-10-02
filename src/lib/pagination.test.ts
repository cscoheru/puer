/**
 * Tests for pagination.ts.
 *
 * Run: node --test --test-reporter=spec src/lib/pagination.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePage, sortSuffix, pageWindow } from "./pagination.ts";

test("parsePage: garbage, NaN, 0 and negative values all fall back to 1", () => {
  assert.equal(parsePage(undefined), 1);
  assert.equal(parsePage(""), 1);
  assert.equal(parsePage("abc"), 1); // parseInt → NaN → rejected
  assert.equal(parsePage("0"), 1);
  assert.equal(parsePage("-3"), 1);
});

test("parsePage: values too large for Prisma's 32-bit skip are rejected", () => {
  assert.equal(parsePage("99999999999"), 1); // a safe integer, but past the cap
  assert.equal(parsePage("1" + "0".repeat(21)), 1); // parseInt → 1e21, not a safe integer
});

test("parsePage: parseInt truncates at the first non-digit — preserved, not fixed", () => {
  // `parseInt("12abc")` is 12, which passes both guards. Both board pages have
  // always accepted this; changing it would alter a public URL's behaviour, so
  // the shared helper keeps it. Asserted so nobody "cleans it up" by accident.
  assert.equal(parsePage("12abc"), 12);
  assert.equal(parsePage("1e21"), 1); // parseInt stops at "e" → 1
});

test("parsePage: plain pages and the upper bound pass through", () => {
  assert.equal(parsePage("1"), 1);
  assert.equal(parsePage("37"), 37);
  assert.equal(parsePage("10000"), 10000); // boundary: accepted
  assert.equal(parsePage("10001"), 1); // boundary: rejected
});

test("sortSuffix: empty when unset, otherwise carries the sort verbatim", () => {
  assert.equal(sortSuffix(undefined), "");
  assert.equal(sortSuffix("latest"), "&sort=latest");
});

test("pageWindow: the current page is always present and positioned in order", () => {
  const w = pageWindow(37, 100);
  assert.ok(w.includes(37));
  // Ascending, with ellipsis only where there is a gap.
  assert.deepEqual(w, [1, "…", 35, 36, 37, 38, 39, "…", 100]);
});

test("pageWindow: no ellipsis when the whole range fits the window", () => {
  assert.deepEqual(pageWindow(3, 6), [1, 2, 3, 4, 5, 6]); // current ±2 covers everything
  assert.deepEqual(pageWindow(1, 4), [1, 2, 3, 4]); // first + last + ±2 covers everything
});

test("pageWindow: a single page renders just itself", () => {
  assert.deepEqual(pageWindow(1, 1), [1]);
});

test("pageWindow: a one-page gap still renders as an ellipsis — preserved, not fixed", () => {
  // pageWindow is lifted verbatim from `src/app/(main)/tea/page.tsx`, which has
  // rendered this since before this module existed. At totalPages 5-7 with the
  // reader at an edge, one hidden page shows as `…` rather than as its number:
  //   pageWindow(1, 5) → 1 2 3 … 5   (page 4 hidden)
  // Collapsing that gap would change what /tea renders, and this cut promises
  // the tea page is byte-identical. Asserted so the wart is a decision, not an
  // accident, and so nobody "fixes" it without noticing the ripple.
  assert.deepEqual(pageWindow(1, 5), [1, 2, 3, "…", 5]);
  assert.deepEqual(pageWindow(5, 5), [1, "…", 3, 4, 5]);
});

test("pageWindow: clamps at both ends without dropping the first/last page", () => {
  assert.deepEqual(pageWindow(1, 20), [1, 2, 3, "…", 20]);
  assert.deepEqual(pageWindow(20, 20), [1, "…", 18, 19, 20]);
});

test("pageWindow: never emits a page outside 1..total", () => {
  for (const [cur, total] of [
    [1, 1],
    [1, 2],
    [2, 2],
    [7, 10],
    [1, 3],
    // Out-of-range currents are reachable: `parsePage` accepts up to 10000 and
    // `BoardPagination` never clamps `page` to `totalPages`, so `?page=9999` on a
    // 10-page board lands here.
    [9999, 10],
    [0, 5],
  ] as const) {
    for (const p of pageWindow(cur, total)) {
      if (p === "…") continue;
      assert.ok(p >= 1 && p <= total, `${p} out of range for ${cur}/${total}`);
    }
  }
});

test("pageWindow: a current page beyond totalPages drops the highlight — PRE-EXISTING, pinned not fixed", () => {
  // `?page=9999` on a 10-page board renders a window of the real pages with none
  // of them highlighted, and the 上一页 link walks further out of range. The old
  // board pager had the same defect (it always printed 1-10, also with nothing
  // highlighted), so this is preserved behaviour. Clamping `page` to `totalPages`
  // would fix it, but that is a second behaviour change in a cut whose contract
  // allows exactly one — the page-window fix. Pinned so the next reader sees the
  // wart is known and deliberate.
  assert.deepEqual(pageWindow(9999, 10), [1, "…", 10]);
  assert.deepEqual(pageWindow(5, 0), []); // zero pages: nothing to render
});
