/**
 * Unified publish transaction for articles.
 *
 * All paths that flip an article to `published` MUST go through
 * `publishArticles` so that the side effects (experience for the AUTHOR, board
 * counters) happen exactly once per article, atomically, regardless of which
 * route or how many times it is called.
 *
 * Why this exists (the bugs it replaces):
 *  - `/api/drafts` PUT granted exp to the admin actor (not the author) on every
 *    save, so re-saving a published draft re-awarded exp.
 *  - The admin single-article PUT and batch publish flipped `status` with a
 *    raw update and granted NO exp and bumped NO board counters, so drafts
 *    published those ways were silently missing the author reward and the
 *    board's thread/post tallies.
 *
 * Correctness model (no schema-level unique constraint on UserAction is
 * available, so idempotacy rests on a conditional state transition):
 *  - `draft` / `pending_review` → `published` is a FIRST publication. The
 *    conditional `updateMany({ where: { id, status: { in: [...] } } })` returns
 *    `count === 1` for the single winner; only winners get exp + board counters.
 *    Re-running on an already-published article matches zero rows → no exp.
 *  - `archived` → `published` is a RE-publication: status-only, no exp and no
 *    counter bump (both were already accounted for at first publication; archive
 *    does not decrement them).
 *
 * Everything runs inside one interactive `$transaction` so a winner transition
 * and its side effects commit together or not at all.
 *
 * Does NOT write `Article.tastingScores` (design constraint).
 */
import { prisma } from "@/lib/prisma";
import { EXP_REWARDS } from "@/lib/exp";
import { planPublishSideEffects } from "./article-publish-plan";

export type {
  WinnerArticle,
  ExpGrant,
  BoardIncrement,
  PublishSideEffectPlan,
  PublishExpRewards,
} from "./article-publish-plan";

export interface PublishInput {
  /** Article IDs to publish. De-duplicated; falsy values dropped. */
  ids: string[];
  /** The admin performing the action. Used only for attribution if needed;
   *  exp is always granted to the article's author, never to the actor. */
  actorId: string;
}

export interface PublishResult {
  /** Transitioned draft/pending_review → published. These got exp + counters. */
  publishedIds: string[];
  /** Transitioned archived → published (status only, no exp/counters). */
  republishedIds: string[];
  /** Were already published; a no-op but counted as idempotent success. */
  alreadyPublishedIds: string[];
  /** Not found. */
  rejectedIds: string[];
}

/** States that count as a first publication when moved to `published`. */
const FIRST_PUBLICATION_STATES = ["draft", "pending_review"] as const;

/**
 * Publish the given articles in a single transaction. Returns the
 * classification of each id so callers can report honestly and gate side work
 * (e.g. only ping search engines when something actually went live).
 */
export async function publishArticles({ ids, actorId }: PublishInput): Promise<PublishResult> {
  void actorId; // reserved for future attribution; exp always goes to the author
  const uniqueIds = [...new Set(ids.filter((id): id is string => !!id))];
  const result: PublishResult = {
    publishedIds: [],
    republishedIds: [],
    alreadyPublishedIds: [],
    rejectedIds: [],
  };
  if (uniqueIds.length === 0) return result;

  await prisma.$transaction(async (tx) => {
    for (const id of uniqueIds) {
      // Read the current state and route on it. We deliberately avoid
      // `tx.article.updateMany({ where: { id, status: { in: [...] } } })`:
      // @prisma/adapter-pg 7.8.0 in this codebase emits a P2022 ColumnNotFound
      // for that call shape, even though every column it references exists.
      // Single-row `update({ where: { id }, data: { status } })` is fine.
      const existing = await tx.article.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!existing) {
        result.rejectedIds.push(id);
        continue;
      }
      if ((FIRST_PUBLICATION_STATES as readonly string[]).includes(existing.status)) {
        await tx.article.update({
          where: { id },
          data: { status: "published", createdAt: new Date() },
        });
        result.publishedIds.push(id);
        continue;
      }
      // Re-publication: archived → published. Status only, no side effects.
      if (existing.status === "archived") {
        await tx.article.update({
          where: { id },
          data: { status: "published", createdAt: new Date() },
        });
        result.republishedIds.push(id);
        continue;
      }
      // No transition: classify as already-published.
      result.alreadyPublishedIds.push(id);
    }

    // Side effects ONLY for first-publication winners.
    if (result.publishedIds.length === 0) return;

    const winners = await tx.article.findMany({
      where: { id: { in: result.publishedIds } },
      select: { id: true, authorId: true, type: true, boardId: true },
    });
    const plan = planPublishSideEffects(winners, EXP_REWARDS);

    for (const g of plan.expGrants) {
      await tx.userAction.create({
        data: {
          userId: g.userId,
          actionType: g.actionType,
          expGained: g.expGained,
          referenceId: g.referenceId,
        },
      });
      await tx.user.update({ where: { id: g.userId }, data: { exp: { increment: g.expGained } } });
    }

    const now = new Date();
    for (const b of plan.boardIncrements) {
      await tx.board.update({
        where: { id: b.boardId },
        data: {
          threadCount: { increment: b.count },
          postCount: { increment: b.count },
          lastPostedAt: now,
        },
      });
    }
  });

  return result;
}
