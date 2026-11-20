import { randomUUID } from "node:crypto";
import {
  FEED_COMMENT_ERROR_CODES,
  FEED_COMMENT_LIMITS,
  type FeedCommentErrorCode,
  type FeedCommentProblem,
  type FeedCommentRecovery,
} from "./feed-comment-contract.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ErrorDefinition {
  status: number;
  title: string;
  detail: string;
  recovery: FeedCommentRecovery;
  retryable: boolean;
  manualRetryLimit: 0 | 1;
  sideEffects: "none" | "unknown";
}

const DEFINITIONS: Record<FeedCommentErrorCode, ErrorDefinition> = {
  "comment.invalid_json": {
    status: 400, title: "Invalid comment JSON", detail: "请求不是有效的 JSON",
    recovery: "edit", retryable: false, manualRetryLimit: 0, sideEffects: "none",
  },
  "comment.invalid_input": {
    status: 400, title: "Invalid comment input", detail: "评论内容或目标不符合要求",
    recovery: "edit", retryable: false, manualRetryLimit: 0, sideEffects: "none",
  },
  "comment.parent_conflict": {
    status: 409, title: "Comment parent changed", detail: "讨论已变化，请到详情确认后回复",
    recovery: "detail", retryable: true, manualRetryLimit: 1, sideEffects: "none",
  },
  "comment.unauthenticated": {
    status: 401, title: "Comment login required", detail: "登录状态已失效；登录后回到此页手动发布",
    recovery: "login", retryable: false, manualRetryLimit: 0, sideEffects: "none",
  },
  "comment.forbidden": {
    status: 403, title: "Comment forbidden", detail: "当前账号暂时不能发表评论",
    recovery: "none", retryable: false, manualRetryLimit: 0, sideEffects: "none",
  },
  "comment.rate_limited": {
    status: 429, title: "Comment rate limited", detail: "评论过于频繁，请稍后再试",
    recovery: "retry", retryable: true, manualRetryLimit: 1, sideEffects: "none",
  },
  "comment.feed_disabled": {
    status: 404, title: "Feed replies disabled", detail: "首页内联回复暂不可用",
    recovery: "detail", retryable: false, manualRetryLimit: 0, sideEffects: "none",
  },
  "comment.moderation_rejected": {
    status: 400, title: "Comment moderation rejected", detail: "内容含违规信息，无法发布",
    recovery: "edit", retryable: false, manualRetryLimit: 0, sideEffects: "none",
  },
  "comment.outcome_unknown": {
    status: 500, title: "Comment outcome unknown", detail: "结果未知，可能已发布；请先在详情核对",
    recovery: "detail", retryable: true, manualRetryLimit: 1, sideEffects: "unknown",
  },
};

export function wantsFeedProblem(req: Request): boolean {
  return req.headers.get("accept")?.toLowerCase().includes("application/problem+json") ?? false;
}

export function feedRequestId(req: Request): string {
  const supplied = req.headers.get("x-request-id")?.trim();
  return supplied && UUID_RE.test(supplied) ? supplied : randomUUID();
}

export function feedProblem(
  code: FeedCommentErrorCode,
  requestId: string,
  options: {
    status?: number;
    context?: FeedCommentProblem["context"];
    retryAfterSeconds?: number;
  } = {},
): Response {
  const definition = DEFINITIONS[code];
  const status = options.status ?? definition.status;
  const body: FeedCommentProblem = {
    type: `urn:puer:comment:${code.slice("comment.".length).replaceAll("_", "-")}`,
    title: definition.title,
    detail: definition.detail,
    status,
    code,
    requestId,
    retryable: definition.retryable,
    recovery: definition.recovery,
    sideEffects: definition.sideEffects,
    manualRetryLimit: definition.manualRetryLimit,
    ...(options.context ? { context: options.context } : {}),
  };
  const headers = new Headers({
    "Content-Type": "application/problem+json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Request-ID": requestId,
  });
  if (options.retryAfterSeconds !== undefined) {
    headers.set("Retry-After", String(Math.max(1, Math.ceil(options.retryAfterSeconds))));
  }
  return Response.json(body, { status, headers });
}

export class FeedBodyError extends Error {
  readonly code: "comment.invalid_json" | "comment.invalid_input";
  readonly context?: FeedCommentProblem["context"];
  readonly status?: number;

  constructor(
    code: "comment.invalid_json" | "comment.invalid_input",
    context?: FeedCommentProblem["context"],
    status?: number,
  ) {
    super(code);
    this.name = "FeedBodyError";
    this.code = code;
    this.context = context;
    this.status = status;
  }
}

/**
 * Total time the server will spend waiting for a request body. The route reads
 * this before `auth()` (a disabled surface must answer 404, not 401), so an
 * unauthenticated client that opens a body and never finishes it would
 * otherwise hold the handler open indefinitely.
 */
const BODY_READ_DEADLINE_MS = 15_000;

class BodyReadDeadline extends Error {}

function readBefore<T>(pending: Promise<T>, remainingMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BodyReadDeadline()), remainingMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Read at most 16 KiB + one byte before JSON parsing. Content-Length is only an
 * early hint; chunked requests and inaccurate lengths are bounded by the stream,
 * and the whole read is bounded by BODY_READ_DEADLINE_MS.
 */
export async function readFeedJsonBody(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > FEED_COMMENT_LIMITS.maxBodyBytes) {
    throw new FeedBodyError("comment.invalid_input", {
      field: "content", unit: "bytes", limit: FEED_COMMENT_LIMITS.maxBodyBytes,
    }, 413);
  }
  if (!req.body) throw new FeedBodyError("comment.invalid_json");

  const reader = req.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: Uint8Array[] = [];
  const deadlineAt = Date.now() + BODY_READ_DEADLINE_MS;
  // Nothing else may read this stream after we stop, so it has to be closed by
  // hand; `releaseLock()` alone would leave a pending read attached.
  let abandoned = false;
  let total = 0;
  try {
    while (true) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        abandoned = true;
        throw new FeedBodyError("comment.invalid_json");
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await readBefore(reader.read(), remaining);
      } catch (error) {
        if (error instanceof BodyReadDeadline) {
          abandoned = true;
          throw new FeedBodyError("comment.invalid_json");
        }
        throw error;
      }
      const { done, value } = chunk;
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > FEED_COMMENT_LIMITS.maxBodyBytes) {
        // Never await this. When the caller passed `req.clone()`, the cancel
        // promise belongs to a tee branch and only settles once the *other*
        // branch is cancelled too — the original request body is still unread
        // here, so awaiting it hangs the handler forever. Cancelling without
        // awaiting still closes this branch and leaves `req` readable.
        void reader.cancel("body too large").catch(() => {});
        abandoned = true;
        throw new FeedBodyError("comment.invalid_input", {
          field: "content", unit: "bytes", limit: FEED_COMMENT_LIMITS.maxBodyBytes,
        }, 413);
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let text: string;
    try {
      text = decoder.decode(merged);
    } catch {
      throw new FeedBodyError("comment.invalid_json");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new FeedBodyError("comment.invalid_json");
    }
  } finally {
    if (abandoned) {
      // Closes the stream (resolving any read still pending from the deadline
      // race) before the lock is released. Not awaited for the tee reason above.
      void reader.cancel("body read abandoned").catch(() => {});
    }
    reader.releaseLock();
  }
}

export type FeedCommentLogCategory = FeedCommentErrorCode |
  "published" | "pending_review" | "statement_timeout" | "transaction_timeout" |
  "internal_error" | "body_read_error" | "moderation_error" | "post_create_effects";

const LOG_CATEGORIES = new Set<string>([
  ...FEED_COMMENT_ERROR_CODES,
  "published", "pending_review", "statement_timeout", "transaction_timeout",
  "internal_error", "body_read_error", "moderation_error", "post_create_effects",
]);

/**
 * Prisma wraps raw-SQL driver errors as P2010 while keeping the PostgreSQL
 * SQLSTATE under `meta.code`; a classifier that only reads the top-level code
 * files a statement timeout as an ordinary internal error. Both the write-side
 * and the read-side classifiers read this one shape.
 */
export function prismaErrorSignals(error: unknown): {
  code: string; metaCode: string; message: string;
} {
  if (typeof error !== "object" || error === null) {
    return { code: "", metaCode: "", message: "" };
  }
  const e = error as { code?: unknown; meta?: unknown; message?: unknown };
  return {
    code: e.code == null ? "" : String(e.code),
    metaCode: e.meta && typeof e.meta === "object"
      ? String((e.meta as { code?: unknown }).code ?? "")
      : "",
    message: typeof e.message === "string" ? e.message : "",
  };
}

export function feedLogCategory(error: unknown): FeedCommentLogCategory {
  if (error instanceof FeedBodyError) return error.code;
  if (typeof error !== "object" || error === null) return "internal_error";
  const { code: direct, metaCode, message } = prismaErrorSignals(error);
  if (direct === "57014" || metaCode === "57014" || /\b57014\b/.test(message)) {
    return "statement_timeout";
  }
  if (direct === "P2028" || metaCode === "P2028" || /\bP2028\b/.test(message)) {
    return "transaction_timeout";
  }
  return "internal_error";
}

/** Allowlisted fields only. Never pass the original error, body or SQL here. */
export function logFeedComment(event: {
  requestId: string;
  route: "POST /api/comments";
  /** "unknown" when the request never declared `surface: "feed"`. */
  surface: "feed" | "unknown";
  status: number;
  target: "article" | "tastingNote" | "unknown";
  gate: "on" | "off";
  nested: boolean;
  category: FeedCommentLogCategory;
  commentId?: string;
  authorSynthetic?: boolean;
  parentAuthorSynthetic?: boolean;
}): void {
  const category = LOG_CATEGORIES.has(event.category) ? event.category : "internal_error";
  console.info("[comment-feed]", JSON.stringify({
    requestId: event.requestId,
    route: event.route,
    surface: event.surface,
    status: event.status,
    target: event.target,
    gate: event.gate,
    nested: event.nested,
    category,
    commentId: event.commentId,
    authorSynthetic: event.authorSynthetic,
    parentAuthorSynthetic: event.parentAuthorSynthetic,
  }));
}
