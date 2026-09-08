/**
 * Pure unit tests for `planPublishSideEffects`.
 *
 * These PROVE the publish side-effect business rules without a database:
 *  - exp is granted to the AUTHOR (never an admin actor; the planner takes no
 *    actor id at all),
 *  - the amount and action type follow the article `type` (tasting vs other),
 *  - per-board counter increments group correctly (N winners in one board → +N),
 *  - and side effects are strictly proportional to winners, so a re-publish
 *    with zero new transitions yields an empty plan (idempotency by
 *    construction, pending the DB-level winner confirmation in test:db).
 *
 * Run: node --test --test-reporter=spec src/lib/article-publish.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planPublishSideEffects, type WinnerArticle } from "./article-publish-plan.ts";

// Mirror of the production EXP_REWARDS (exp.ts). Asserting these literal values
// here also documents the expected reward amounts.
const EXP = { post_tasting: 10, post_article: 30 };

const W = (over: Partial<WinnerArticle>): WinnerArticle => ({
  id: "a-1",
  authorId: "author-1",
  type: "article",
  boardId: "board-1",
  ...over,
});

test("no winners → no side effects (idempotency by construction)", () => {
  const plan = planPublishSideEffects([], EXP);
  assert.deepEqual(plan.expGrants, []);
  assert.deepEqual(plan.boardIncrements, []);
});

test("tasting winner grants post_tasting (10) to the author with referenceId", () => {
  const plan = planPublishSideEffects([W({ id: "a-1", authorId: "auth", type: "tasting" })], EXP);
  assert.equal(plan.expGrants.length, 1);
  assert.deepEqual(plan.expGrants[0], {
    userId: "auth",
    actionType: "post_tasting",
    expGained: 10,
    referenceId: "a-1",
  });
});

test("non-tasting winner grants post_article (30)", () => {
  const plan = planPublishSideEffects([W({ id: "a-2", authorId: "auth", type: "article" })], EXP);
  assert.deepEqual(plan.expGrants[0], {
    userId: "auth",
    actionType: "post_article",
    expGained: 30,
    referenceId: "a-2",
  });
});

test("null type is treated as post_article", () => {
  const plan = planPublishSideEffects([W({ type: null })], EXP);
  assert.equal(plan.expGrants[0].actionType, "post_article");
  assert.equal(plan.expGrants[0].expGained, 30);
});

test("winner with null authorId gets NO exp grant", () => {
  const plan = planPublishSideEffects([W({ authorId: null })], EXP);
  assert.equal(plan.expGrants.length, 0);
  // Board counter still increments — counters depend on boardId, not author.
  assert.equal(plan.boardIncrements.length, 1);
});

test("multiple winners in the SAME board produce ONE increment with the summed count", () => {
  const plan = planPublishSideEffects(
    [
      W({ id: "a-1", boardId: "board-x" }),
      W({ id: "a-2", boardId: "board-x" }),
      W({ id: "a-3", boardId: "board-x" }),
    ],
    EXP,
  );
  assert.equal(plan.boardIncrements.length, 1);
  assert.deepEqual(plan.boardIncrements[0], { boardId: "board-x", count: 3 });
});

test("winners across DIFFERENT boards produce separate increments", () => {
  const plan = planPublishSideEffects(
    [
      W({ id: "a-1", boardId: "board-x" }),
      W({ id: "a-2", boardId: "board-y" }),
      W({ id: "a-3", boardId: "board-x" }),
    ],
    EXP,
  );
  const byBoard = new Map(plan.boardIncrements.map((b) => [b.boardId, b.count]));
  assert.equal(byBoard.get("board-x"), 2);
  assert.equal(byBoard.get("board-y"), 1);
});

test("winner with null boardId produces no board increment but still grants exp", () => {
  const plan = planPublishSideEffects([W({ id: "a-1", authorId: "auth", boardId: null })], EXP);
  assert.equal(plan.boardIncrements.length, 0);
  assert.equal(plan.expGrants.length, 1);
});

test("exp always targets the author; the planner has no notion of an admin actor", () => {
  // If a regression introduced an actor id, it would have to be a parameter;
  // the function signature takes only `winners` (+ exp table), so exp can only
  // come from winner.authorId. Assert every grant's userId is some winner's authorId.
  const winners = [
    W({ id: "a-1", authorId: "author-a", type: "tasting" }),
    W({ id: "a-2", authorId: "author-b", type: "article" }),
  ];
  const plan = planPublishSideEffects(winners, EXP);
  const authorIds = new Set(winners.map((w) => w.authorId));
  for (const g of plan.expGrants) {
    assert.ok(authorIds.has(g.userId), `exp grant targeted ${g.userId}, not an author`);
  }
  assert.equal(plan.expGrants.length, 2);
});

test("each winner yields at most one exp grant (no duplicate rewards)", () => {
  const plan = planPublishSideEffects([W({ id: "a-1", authorId: "auth" })], EXP);
  assert.equal(plan.expGrants.length, 1);
});
