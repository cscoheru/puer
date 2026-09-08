/**
 * Pure publish side-effect planner (zero imports, no DB, no `@/` alias).
 *
 * Split out of `article-publish.ts` so it stays runnable under `node --test`,
 * which does not resolve the `@/` tsconfig path alias. The exp reward table is
 * passed in (not imported) to keep this module dependency-free and to make the
 * amounts explicit and overridable in tests.
 *
 * Given the CONFIRMED first-publication winners, returns the exact exp grants
 * and per-board counter increments to apply. Side effects are strictly
 * proportional to the winners passed in, so an empty winners list yields an
 * empty plan — that is how idempotency is enforced once the DB layer confirms
 * there were no new draft/pending_review→published transitions.
 */

export interface WinnerArticle {
  id: string;
  authorId: string | null;
  type: string | null;
  boardId: string | null;
}

export interface ExpGrant {
  userId: string;
  actionType: "post_tasting" | "post_article";
  expGained: number;
  referenceId: string;
}

export interface BoardIncrement {
  boardId: string;
  count: number;
}

export interface PublishSideEffectPlan {
  expGrants: ExpGrant[];
  boardIncrements: BoardIncrement[];
}

/** Reward amounts for the two publish action types. */
export interface PublishExpRewards {
  post_tasting: number;
  post_article: number;
}

export function planPublishSideEffects(
  winners: WinnerArticle[],
  expRewards: PublishExpRewards,
): PublishSideEffectPlan {
  const expGrants: ExpGrant[] = [];
  for (const w of winners) {
    if (!w.authorId) continue;
    const actionType = w.type === "tasting" ? "post_tasting" : "post_article";
    expGrants.push({
      userId: w.authorId,
      actionType,
      expGained: expRewards[actionType],
      referenceId: w.id,
    });
  }

  const perBoard = new Map<string, number>();
  for (const w of winners) {
    if (!w.boardId) continue;
    perBoard.set(w.boardId, (perBoard.get(w.boardId) ?? 0) + 1);
  }
  const boardIncrements: BoardIncrement[] = [...perBoard.entries()].map(
    ([boardId, count]) => ({ boardId, count }),
  );

  return { expGrants, boardIncrements };
}
