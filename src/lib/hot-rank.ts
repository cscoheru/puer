/**
 * Hot-ranking primitives — pure, import-free, and therefore unit-testable.
 *
 * This module exists because the scoring formula used to live inside
 * `src/lib/board-threads.ts`, which opens with `import { prisma }` — and
 * `src/lib/prisma.ts` instantiates `PrismaClient` at module load. Anything
 * importing that tree wants a database, so nothing could unit-test the ranking
 * at all. Every function here is a pure expression of its arguments: no clock,
 * no I/O, no path aliases, no type assertions.
 *
 * Two things are deliberately *not* unified here, and the split is the point:
 *
 * - **The pipelines stay different.** `board-threads.ts` runs a flat ranking;
 *   `forum-feed-server.ts`'s `hotRankAndPage` layers v4.0 on top — 48h
 *   cold-start, max 3 posts per author, opportunity boost for posts ranked
 *   15-50, archive fallback. Only the arithmetic below is shared. Collapsing
 *   the pipelines would change what readers see.
 * - **The media decision stays outside.** `hasMedia` is injected rather than
 *   computed here, because AGENTS.md R26 requires every image extraction to go
 *   through `extractFeedImages()` (content ∪ images), and that helper lives in
 *   a module that pulls in Prisma. Passing the boolean keeps this file pure
 *   while leaving the R26-compliant call where it belongs — at the edge.
 */

/**
 * The subset of a thread row that ranking actually reads.
 *
 * Note `hasMedia` instead of `content`/`images`/`videoUrl`: see the module
 * docstring. Callers compute it as `!!(videoUrl || coverImage)` where
 * `coverImage` comes from `extractFeedImages`.
 */
export interface HotRankInputs {
  id: string;
  upvotes: number;
  downvotes: number;
  replyCount: number;
  viewCount: number;
  hasMedia: boolean;
  createdAt: Date;
  lastRepliedAt: Date | null;
}

/**
 * `contentQuality × mediaBonus × timeBonus` — the one formula every hot-ranking
 * surface derives from. Tuning the weights here moves the board page and the
 * home feed together, which is the reason it is shared rather than copied.
 *
 *   contentQuality = log1p(netVotes)×6 + log1p(replies)×4 + log1p(min(views,1000))×0.2
 *   mediaBonus     = 1.3 when the post has an image or a video, else 1
 *   timeBonus      = 1 + 0.3/(1 + ageHours/48), age capped at 720h
 *
 * Age is measured from `lastRepliedAt ?? createdAt`, so a post that gets a new
 * reply is refreshed. Time only ever *adds*; a stale post is never penalised,
 * which is the v3.0 decision that replaced the older divide-by-age decay.
 *
 * @param now injected epoch ms — the only reason this is deterministic enough
 *            to test. Callers pass `Date.now()` at the edge.
 */
export function scoreThread(t: HotRankInputs, now: number): number {
  const net = Math.max(0, t.upvotes - t.downvotes);
  const score =
    Math.log1p(net) * 6 +
    Math.log1p(t.replyCount) * 4 +
    Math.log1p(Math.min(t.viewCount, 1000)) * 0.2;
  const boost = t.hasMedia ? 1.3 : 1;
  const ageMs = now - new Date(t.lastRepliedAt || t.createdAt).getTime();
  const age = Math.min(ageMs / 3600000, 720);
  const timeBonus = 1 + 0.3 / (1 + age / 48);
  return score * boost * timeBonus;
}

/**
 * Seed for the per-reader personalization jitter: `hash("<user>:<bucket>")`.
 *
 * The `bucket` is passed in rather than read from the clock because the two
 * pipelines deliberately disagree on its granularity — the board page rotates
 * daily (`Math.floor(now / 86400000)`) so a reader's board is stable all day,
 * the home feed rotates hourly (`Math.floor(now / 3600000)`) so repeated
 * refreshes reshuffle. That product decision stays at the call site; only the
 * hashing is shared.
 *
 * The hash is the classic `h = h*31 + c` in the `<<5` form, kept identical to
 * the pre-split code so existing orderings do not shift under readers.
 */
export function jitterSeed(sessionUserId: string | undefined, bucket: number): number {
  const seedStr = (sessionUserId || "anon") + ":" + bucket;
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) {
    seed = ((seed << 5) - seed) + seedStr.charCodeAt(i);
    seed |= 0;
  }
  return Math.abs(seed);
}

/**
 * How much a row's jitter counts for, by its **hot** rank:
 * top 5 full strength, the next 10 at 60%, everything below at 30%.
 *
 * `index` must be the position in the `_hotScore` ordering, never the position
 * in the jittered (`_finalScore`) ordering. Feeding the latter back in creates
 * a self-reinforcing loop — a row that jitter happens to lift keeps drawing the
 * full-strength coefficient and stays lifted. The signature takes an index
 * rather than the row's current position in a sorted array to make that hard
 * to get wrong by accident.
 */
export function tierFactor(index: number, topN: number): number {
  return index < topN ? 1.0 : index < topN + 10 ? 0.6 : 0.3;
}

/**
 * Per-row jitter magnitude in `[0, 0.40]`, a pure function of the row id and
 * the seed. Same id + same seed ⇒ same value, which is what makes the ordering
 * stable for a reader within one bucket.
 */
export function jitterAmount(id: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h) + id.charCodeAt(i);
    h |= 0;
  }
  return (Math.abs(h) % 41) / 100;
}

/**
 * The board-page ranking: score, order by `_hotScore`, apply per-reader jitter,
 * return in `_finalScore` order.
 *
 * Both decorated fields are returned because the pipeline needs them and the
 * caller (`loadBoardThreads`) strips them again before the rows reach the page
 * — a score is ranking state, not page data. The historical shape of the return
 * type is preserved so the pinned-merge in `board-threads.ts` keeps working.
 *
 * Determinism contract, pinned by `hot-rank.test.ts`:
 * `_hotScore` and the `_hotScore` ordering are identical for every reader — the
 * base ranking is not personal. Only the returned order may differ, and only
 * because of `_finalScore`. In other words `_hotScore` is the ranking;
 * `_finalScore` is a view of it.
 */
export function applyHotRank<T extends HotRankInputs>(
  threads: T[],
  opts: { now: number; bucket: number; sessionUserId?: string },
): (T & { _hotScore: number; _finalScore: number })[] {
  const { now, bucket, sessionUserId } = opts;

  const scored = threads.map((t) => ({
    ...t,
    _hotScore: scoreThread(t, now),
  }));

  scored.sort((a, b) => b._hotScore - a._hotScore);

  const seed = jitterSeed(sessionUserId, bucket);
  const topN = Math.min(5, scored.length);

  return scored
    .map((a, i) => ({
      ...a,
      _finalScore: a._hotScore * (1 + jitterAmount(a.id, seed) * tierFactor(i, topN)),
    }))
    .sort((a, b) => b._finalScore - a._finalScore);
}
