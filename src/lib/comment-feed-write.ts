import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "./prisma.ts";
import { canViewArticleDetail } from "./article-visibility.ts";
import { commentVisibility } from "./comment-visibility.ts";
import { ORIGIN_HUMAN } from "./content-origin.ts";
import {
  FEED_COMMENT_LIMITS,
  validateFeedCommentText,
} from "./feed-comment-contract.ts";
import { can, type Actor } from "./permissions.ts";

export interface FeedCommentInput {
  articleId: string;
  content: string;
  /**
   * Feed replies always answer an existing comment. The feed card has no root
   * composer, so `null` is invalid here (the legacy detail path owns roots).
   */
  parentId: string;
  images: [];
  surface: "feed";
}

export type FeedInputValidation =
  | { ok: true; value: FeedCommentInput }
  | {
      ok: false;
      code: "comment.invalid_input";
      context?: {
        field?: "articleId" | "tastingNoteId" | "content" | "parentId" | "images" | "surface";
        unit?: "utf16_code_units";
        limit?: number;
        actual?: number;
      };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateFeedCommentPayload(body: unknown): FeedInputValidation {
  if (!isRecord(body)) return { ok: false, code: "comment.invalid_input" };
  if (body.surface !== "feed") {
    return { ok: false, code: "comment.invalid_input", context: { field: "surface" } };
  }
  if (typeof body.articleId !== "string" || !body.articleId.trim() || body.tastingNoteId != null) {
    return { ok: false, code: "comment.invalid_input", context: { field: "articleId" } };
  }
  if (!Array.isArray(body.images) || body.images.length !== 0) {
    return { ok: false, code: "comment.invalid_input", context: { field: "images" } };
  }
  // The feed card only replies to an existing comment; `null` (a root) is invalid.
  if (typeof body.parentId !== "string" || !body.parentId.trim()) {
    return { ok: false, code: "comment.invalid_input", context: { field: "parentId" } };
  }
  const text = validateFeedCommentText(body.content);
  if (!text.ok) {
    return {
      ok: false,
      code: "comment.invalid_input",
      context: {
        field: "content",
        unit: "utf16_code_units",
        limit: FEED_COMMENT_LIMITS.maxTextUnits,
        actual: text.units,
      },
    };
  }
  return {
    ok: true,
    value: {
      articleId: body.articleId.trim(),
      content: text.value,
      parentId: body.parentId.trim(),
      images: [],
      surface: "feed",
    },
  };
}

export class ParentCommentConflict extends Error {
  constructor() {
    super("comment.parent_conflict");
    this.name = "ParentCommentConflict";
  }
}

export interface CommentTarget {
  articleId?: string | null;
  tastingNoteId?: string | null;
}

/**
 * Detail-page visibility gate for a write target. A comment must never be
 * created on an article the actor cannot open: the row would be invisible to
 * them while still firing reply counters and author notifications. Reads take
 * the same gate, so `actor` may be null (anonymous visitor).
 */
export async function findVisibleArticle(articleId: string, actor: Actor | null | undefined) {
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { status: true, visibility: true, authorId: true },
  });
  if (!article) return null;
  return canViewArticleDetail(article, {
    userId: actor?.id ?? null,
    isAdmin: can(actor, "admin:access"),
  }) ? article : null;
}

/** Detail-path parent check. Feed uses the locked transaction variant below. */
export async function findVisibleParent(
  parentId: string,
  target: CommentTarget,
  actor: Actor | null | undefined,
) {
  const visibility = commentVisibility(actor);
  return prisma.comment.findFirst({
    where: {
      id: parentId,
      articleId: target.articleId ?? null,
      tastingNoteId: target.tastingNoteId ?? null,
      AND: [visibility.prismaWhere],
    },
    select: { id: true, author: { select: { isSynthetic: true } } },
  });
}

interface LockedParentRow {
  id: string;
  articleId: string | null;
  tastingNoteId: string | null;
}

/** Lock, authorize and insert in one database transaction. Effects run later. */
export async function createFeedCommentWithVisibleParent(opts: {
  input: FeedCommentInput;
  actor: Actor;
  publish: boolean;
  moderation?: Prisma.InputJsonValue;
}) {
  const { input, actor, publish, moderation } = opts;
  const isAdmin = can(actor, "admin:access");
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<LockedParentRow[]>`
      SELECT c.id, c."articleId", c."tastingNoteId"
      FROM comments c
      WHERE c.id = ${input.parentId}
      FOR UPDATE
    `;
    const parent = locked[0];
    if (!parent || parent.articleId !== input.articleId || parent.tastingNoteId !== null) {
      throw new ParentCommentConflict();
    }

    // The target article must be open on the detail page too. Otherwise a reply
    // lands on a private/pending article its own author cannot reopen, while
    // still firing counters and author notifications.
    const article = await tx.article.findUnique({
      where: { id: input.articleId },
      select: { status: true, visibility: true, authorId: true },
    });
    if (!article || !canViewArticleDetail(article, { userId: actor.id, isAdmin })) {
      throw new ParentCommentConflict();
    }

    const visibility = commentVisibility(actor);
    const visible = await tx.comment.findFirst({
      where: {
        id: input.parentId,
        articleId: input.articleId,
        tastingNoteId: null,
        AND: [visibility.prismaWhere],
      },
      select: { id: true, author: { select: { isSynthetic: true } } },
    });
    if (!visible) throw new ParentCommentConflict();
    const parentAuthorSynthetic = visible.author.isSynthetic;

    const comment = await tx.comment.create({
      data: {
        articleId: input.articleId,
        content: input.content,
        images: [],
        parentId: input.parentId,
        authorId: actor.id,
        status: publish ? "published" : "pending_review",
        origin: ORIGIN_HUMAN,
        moderation,
      },
      include: {
        author: { select: { id: true, username: true, avatar: true, level: true } },
      },
    });
    return { comment, parentAuthorSynthetic };
  }, { timeout: FEED_COMMENT_LIMITS.transactionTimeoutMs });
}
