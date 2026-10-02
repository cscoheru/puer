/**
 * Forum pagination — pure helpers, shared by the simplified and traditional
 * board pages so a page link cannot mean two different things across the pair.
 *
 * Import-free by design (see `hot-rank.ts` for why): `node --test` runs these
 * tests directly against the source with no bundler and no `@/` path alias, so
 * anything reachable from a test file must not pull in Prisma or the Next
 * server runtime.
 */

/**
 * Parses `?page=`.
 *
 * `Math.max(1, parseInt(x))` is not a guard: `parseInt` yields `NaN` for
 * garbage and `Math.max(1, NaN)` is `NaN`, which reaches Prisma's `skip` as
 * `NaN` and 500s the board. The upper bound keeps a crafted `?page=99999999999`
 * from overflowing Prisma's 32-bit `skip`. Anything that does not survive both
 * checks falls back to page 1 rather than erroring — a public URL should
 * degrade, not fail.
 *
 * `parseInt` truncating at the first non-digit (`"12abc"` → 12) is deliberate
 * legacy behaviour kept for the same reason: both board pages have always
 * accepted it, and tightening it here would change what a live URL renders.
 */
export function parsePage(raw: string | undefined): number {
  const n = parseInt(raw || "1", 10);
  return Number.isSafeInteger(n) && n > 0 && n <= 10000 ? n : 1;
}

/**
 * Carries the active sort across page links.
 *
 * The previous inline form emitted the suffix whenever the sort was *not*
 * "latest" — which dropped 最新 on page 2 (the reader silently got the hot
 * ranking back) and produced `&sort=undefined` when no sort was set at all.
 * Empty string when unset, so it concatenates without a conditional.
 *
 * The argument is the literal `"latest"`, not `string`, deliberately: both pages
 * normalise `searchParams.sort` down to that one value before it gets here, and
 * a bare `string` would let a future caller hand this raw reflected input to
 * build an href. Keep the allowlist here rather than re-deriving it at every
 * call site — `encodeURIComponent` would only stop query injection, not the
 * `&` / `#` truncation a raw string still permits.
 */
export function sortSuffix(sort: "latest" | undefined): string {
  return sort ? `&sort=${sort}` : "";
}

/**
 * Page numbers to render: first, last, and the current page ± 2, with `…` for
 * each gap that hides more than one page.
 *
 * This replaces the form the board pages used to inline —
 * `Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1)` — which
 * always rendered pages 1-10 no matter where the reader was. On page 37 they
 * saw a row of 1-10 with none highlighted and could only walk forward one page
 * at a time. The shape is lifted from `src/app/(main)/tea/page.tsx`, which had
 * already solved this correctly.
 *
 * Two rules keep that fix from costing anything where it is not needed:
 *
 *   1. **Short sets are listed in full.** Up to 10 pages there is no window to
 *      compute — every page is one click away, and 10 is exactly the bound the
 *      old board pager used, so nothing that used to be visible is hidden.
 *      Without this, a 7-page board would render `1 2 3 … 7` and pages 4-6
 *      would lose their links entirely.
 *   2. **A gap of one page shows that page, not `…`.** `…` is a literal
 *      ellipsis, not a page — callers must not wrap it in a `<Link>` — so it is
 *      a dead end for anything it stands for. An ellipsis representing a single
 *      page destroys navigation to buy nothing.
 *
 * Out-of-range `current` (see `parsePage`, which accepts up to 10000) is not
 * clamped here: the window is built from the real pages and the caller's
 * highlight simply does not match any of them. That is pinned in
 * `pagination.test.ts`, not fixed.
 */
export function pageWindow(current: number, total: number): (number | "…")[] {
  if (total <= 10) {
    return Array.from({ length: Math.max(0, total) }, (_, i) => i + 1);
  }
  const wanted = new Set<number>([1, total, current, current - 1, current + 1, current - 2, current + 2]);
  const nums = [...wanted].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  for (let i = 0; i < nums.length; i++) {
    const gap = i > 0 ? nums[i] - nums[i - 1] - 1 : 0;
    if (gap === 1) out.push(nums[i - 1] + 1); // a lone hidden page is more useful than `…`
    else if (gap > 1) out.push("…");
    out.push(nums[i]);
  }
  return out;
}
