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
 * each gap.
 *
 * This replaces the form the board pages used to inline —
 * `Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1)` — which
 * always rendered pages 1-10 no matter where the reader was. On page 37 they
 * saw a row of 1-10 with none highlighted and could only walk forward one page
 * at a time. The shape is lifted from `src/app/(main)/tea/page.tsx`, which had
 * already solved this correctly.
 *
 * `…` is a literal ellipsis, not a page; callers must not wrap it in a `<Link>`.
 * A gap of one page still renders as `…` (so `pageWindow(1, 5)` is
 * `[1, 2, 3, "…", 5]`) — that is the shape this was lifted from and the tea
 * page has always rendered. See `pagination.test.ts` before changing it.
 */
export function pageWindow(current: number, total: number): (number | "…")[] {
  const wanted = new Set<number>([1, total, current, current - 1, current + 1, current - 2, current + 2]);
  const nums = [...wanted].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  for (let i = 0; i < nums.length; i++) {
    if (i > 0 && nums[i] - nums[i - 1] > 1) out.push("…");
    out.push(nums[i]);
  }
  return out;
}
