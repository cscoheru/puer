/**
 * Runtime-free contract shared by feed SSR, lazy responses and browser code.
 *
 * Keep Prisma, auth and server-only imports out of this module: forum-feed.tsx
 * imports these types and validators into the client bundle.
 */

export const FEED_COMMENT_LIMITS = {
  humanPreview: 2,
  aiFallback: 1,
  previewCodePoints: 1024,
  minTextUnits: 5,
  maxTextUnits: 2000,
  maxBodyBytes: 16 * 1024,
  watchdogMs: 60_000,
  statementTimeoutMs: 1_500,
  transactionTimeoutMs: 2_000,
} as const;

export const FEED_COMMENT_ERROR_CODES = [
  "comment.invalid_json",
  "comment.invalid_input",
  "comment.parent_conflict",
  "comment.unauthenticated",
  "comment.forbidden",
  "comment.rate_limited",
  "comment.feed_disabled",
  "comment.moderation_rejected",
  "comment.outcome_unknown",
] as const;

export type FeedCommentErrorCode = (typeof FEED_COMMENT_ERROR_CODES)[number];
export type FeedCommentRecovery = "edit" | "login" | "detail" | "retry" | "none";
export type FeedCommentSideEffects = "none" | "unknown";

export interface FeedCommentAuthorDTO {
  id: string;
  username: string;
  avatar: string | null;
  level: number;
}

export interface FeedCommentPreviewItem {
  id: string;
  articleId: string;
  /** Initial feed rows are top-level. Locally created descendants keep their real parent ID. */
  parentId: string | null;
  content: string;
  contentTruncated: boolean;
  status: string;
  origin: string | null;
  createdAt: string;
  author: FeedCommentAuthorDTO;
}

export interface FeedCommentFields {
  /** null = read failed; [] = successfully read, but no top-level preview. */
  commentPreview: FeedCommentPreviewItem[] | null;
  /** Whole GET-visible tree cardinality; null means the independent count read failed. */
  visibleReplyCount: number | null;
  /** One correlation ID per feed load, repeated on each article DTO. */
  commentLoadId: string;
}

export interface FeedCommentProblem {
  type: `urn:puer:comment:${string}`;
  title: string;
  detail: string;
  status: number;
  code: FeedCommentErrorCode;
  requestId: string;
  retryable: boolean;
  recovery: FeedCommentRecovery;
  sideEffects: FeedCommentSideEffects;
  manualRetryLimit: 0 | 1;
  context?: {
    field?: "articleId" | "tastingNoteId" | "content" | "parentId" | "images" | "surface";
    unit?: "utf16_code_units" | "bytes";
    limit?: number;
    actual?: number;
    commentLoadId?: string;
  };
}

export type FeedCommentTextValidation =
  | { ok: true; value: string; units: number }
  | {
      ok: false;
      value: string;
      units: number;
      reason: "not_string" | "too_short" | "too_long";
    };

/** JavaScript string length is UTF-16 code units, including two units for astral symbols. */
export function validateFeedCommentText(input: unknown): FeedCommentTextValidation {
  if (typeof input !== "string") {
    return { ok: false, value: "", units: 0, reason: "not_string" };
  }
  const value = input.trim();
  const units = value.length;
  if (units < FEED_COMMENT_LIMITS.minTextUnits) {
    return { ok: false, value, units, reason: "too_short" };
  }
  if (units > FEED_COMMENT_LIMITS.maxTextUnits) {
    return { ok: false, value, units, reason: "too_long" };
  }
  return { ok: true, value, units };
}

export function isFeedInlineRepliesEnabled(value: unknown): boolean {
  return value === "1";
}

export function isFeedCommentErrorCode(value: unknown): value is FeedCommentErrorCode {
  return typeof value === "string" &&
    (FEED_COMMENT_ERROR_CODES as readonly string[]).includes(value);
}
