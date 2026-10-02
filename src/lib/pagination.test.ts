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

test("pageWindow: the whole range is shown whenever it fits — which is only ever the <=10 case", () => {
  // Since the threshold landed these exercise the shortcut, not the window loop.
  // That is not an accident: for total > 10 the window can never show every page,
  // because 1 and total are always pinned and at most 7 values can be wanted. So
  // "whole range fits" and "total <= 10" are now the same condition. The loop
  // itself is covered by the cases below.
  assert.deepEqual(pageWindow(3, 6), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(pageWindow(1, 4), [1, 2, 3, 4]);
});

test("pageWindow: a single page renders just itself", () => {
  assert.deepEqual(pageWindow(1, 1), [1]);
});

test("pageWindow: sets up to 10 pages are listed in full — no ellipsis, nothing hidden", () => {
  // The bound is 10 because that is what the board pager's old
  // `Math.min(totalPages, 10)` used. Matching it guarantees no page that used to
  // be clickable disappears: a 7-page board rendered `1 2 3 4 5 6 7` before the
  // shared module existed and must render the same now.
  assert.deepEqual(pageWindow(1, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(pageWindow(5, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(pageWindow(1, 7), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(pageWindow(7, 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("pageWindow: a one-page gap shows the page rather than an ellipsis", () => {
  // `…` is a `<span>`, not a link, so anything it stands for becomes
  // unreachable except by walking 下一页. An ellipsis that hides exactly one page
  // therefore spends navigation to buy nothing. Only past the 10-page threshold
  // can this arise at all, since shorter sets are listed in full.
  //
  // Right side — current 8 of 12 → wanted {1, 6, 7, 8, 9, 10, 12}: page 11 sits
  // alone between the run and the tail.
  assert.deepEqual(pageWindow(8, 12), [1, "…", 6, 7, 8, 9, 10, 11, 12]);
  // Left side — current 5 of 12 → wanted {1, 3, 4, 5, 6, 7, 12}: page 2 sits
  // alone between the first page and the run. Both sides must be asserted: an
  // implementation that only fills at the tail keeps the case above green while
  // dropping page 2 here with no ellipsis to mark the hole — a silent gap, which
  // is worse than the ellipsis bug this rule exists to fix.
  assert.deepEqual(pageWindow(5, 12), [1, 2, 3, 4, 5, 6, 7, "…", 12]);
  // Two pages to hide is already worth an ellipsis, so this one is unchanged by
  // the rule and pins the boundary.
  assert.deepEqual(pageWindow(7, 12), [1, "…", 5, 6, 7, 8, 9, "…", 12]);
});

test("pageWindow: the rules hold as properties, not just at the cases above", () => {
  // The contract is a *property* of the window, so hand-picked shapes do not pin
  // it: an edit can satisfy every case above and still lose a page elsewhere.
  // Stated in full, the window owes the reader exactly two things:
  //
  //   A. **Nothing vanishes silently.** Every page in 1..total is either a link
  //      or is visibly stood for by a `…`. A page that simply disappears — a gap
  //      between two rendered numbers with no ellipsis — is worse than the bug
  //      this rule set exists to fix, because the reader gets no signal at all.
  //   B. **No link is traded for a dead end.** `…` is a `<span>`, so it must only
  //      appear where it stands for at least two pages.
  //
  // A mutant that satisfies B but not A (fill a lone gap only at the tail) keeps
  // every case in the test above green while deleting a page — so both directions
  // are swept below, not just B.
  const check = (current: number, total: number) => {
    const w = pageWindow(current, total);
    const where = `pageWindow(${current}, ${total}) = ${JSON.stringify(w)}`;

    // Rule 1: up to 10 pages there is nothing to hide. The `deepEqual` alone
    // proves it: the expected value is the bare run of page numbers, so any
    // ellipsis (or any omission) fails it.
    if (total <= 10) {
      assert.deepEqual(
        w,
        Array.from({ length: Math.max(0, total) }, (_, i) => i + 1),
        where,
      );
      return;
    }

    const rendered = new Set<number>();
    const stoodFor = new Set<number>();
    for (let i = 0; i < w.length; i++) {
      if (w[i] !== "…") {
        rendered.add(w[i] as number);
        continue;
      }
      const before = w[i - 1];
      const after = w[i + 1];
      // Rule A also forbids an ellipsis hanging off either end, where it would
      // have no page on one side to be about.
      assert.equal(typeof before, "number", `ellipsis at the start: ${where}`);
      assert.equal(typeof after, "number", `ellipsis at the end: ${where}`);
      const lo = (before as number) + 1;
      const hi = (after as number) - 1;
      // Rule B.
      assert.ok(hi - lo + 1 >= 2, `ellipsis hides fewer than 2 pages: ${where}`);
      for (let p = lo; p <= hi; p++) stoodFor.add(p);
    }

    // Rule A: every page is a link or is stood for, and the two never overlap
    // (the size check fails if a page is counted on both sides).
    const missing: number[] = [];
    for (let p = 1; p <= total; p++) {
      if (!rendered.has(p) && !stoodFor.has(p)) missing.push(p);
    }
    assert.deepEqual(missing, [], `pages neither linked nor stood for: ${where}`);
    assert.equal(
      rendered.size + stoodFor.size,
      total,
      `pages lost or double-counted: ${where}`,
    );
  };

  // Every total a small board can reach, against every current alongside it.
  for (let total = 0; total <= 40; total++) {
    for (let current = 0; current <= 40; current++) check(current, total);
  }
  // Production-reachable extremes. `parsePage` accepts up to 10000 and never
  // clamps to totalPages, so far-out-of-range currents are real URLs; totals past
  // 40 are real too (a board passes 40 pages at 800 threads).
  for (const total of [41, 60, 100, 500, 1000]) {
    for (const current of [
      -5, 0, 1, 2, total - 1, total, total + 1, total + 2, 500, 9999, 10000,
    ]) {
      check(current, total);
    }
  }
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
  // `?page=9999` on a board with far fewer pages renders the real pages with
  // none of them highlighted, and the 上一页 link walks further out of range. The
  // old board pager had the same defect (it always printed 1-10, also with
  // nothing highlighted), so this is preserved behaviour. Clamping `page` to
  // `totalPages` would fix it, but that is a behaviour change beyond the
  // page-window work this module was created for. Pinned so the next reader
  // sees the wart is known and deliberate.
  //
  // Below the threshold every real page is listed, so the out-of-range current
  // simply matches nothing; above it the window falls back to first + last — but
  // only once the whole ±2 cluster has left 1..total. Just past the end the
  // trailing run survives: `pageWindow(12, 11)` is `[1, "…", 10, 11]`, because
  // `current - 2` is still a real page. Asserted so the comment cannot overclaim.
  assert.deepEqual(pageWindow(9999, 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(!pageWindow(9999, 10).includes(9999));
  assert.deepEqual(pageWindow(9999, 20), [1, "…", 20]);
  assert.deepEqual(pageWindow(12, 11), [1, "…", 10, 11]);
  assert.deepEqual(pageWindow(5, 0), []); // zero pages: nothing to render
});
