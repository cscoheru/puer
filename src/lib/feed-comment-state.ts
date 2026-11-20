import {
  FEED_COMMENT_LIMITS,
  isFeedCommentErrorCode,
  validateFeedCommentText,
  type FeedCommentErrorCode,
  type FeedCommentPreviewItem,
  type FeedCommentProblem,
} from "./feed-comment-contract.ts";

export type FeedCommentRetryCategory = "rate_limited" | "outcome_unknown" | "parent_conflict";

/**
 * Correlation id for one POST. `crypto.randomUUID` is missing on insecure
 * origins and some WebViews, and `submit()` calls the id generator *before* it
 * arms the watchdog — a throw there rejects the promise callers invoke with
 * `void`, so the reply button appears dead with no message and no request.
 * The server only needs a UUID-shaped string to log against, not entropy.
 */
export function newFeedCommentRequestId(): string {
  try {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  } catch {
    // Fall through to the shape-compatible generator below.
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (slot) => {
    const nibble = Math.floor(Math.random() * 16);
    return (slot === "x" ? nibble : (nibble & 0x3) | 0x8).toString(16);
  });
}

export interface FeedCommentUiError {
  code: FeedCommentErrorCode;
  requestId?: string;
  detail?: string;
  revision: number;
  content: string;
  retryAtMs?: number;
  retryAfterSeconds?: number;
  category:
    | "server"
    | "network"
    | "watchdog"
    | "bad_success"
    | "http";
}

export interface FeedCommentDraft {
  text: string;
  revision: number;
  /** Stable across edits and cancel/reopen. A successful draft gets a new intent next time. */
  intentId: number;
  retries: Partial<Record<FeedCommentRetryCategory, number>>;
  retryReady: Partial<Record<FeedCommentRetryCategory, true>>;
  error: FeedCommentUiError | null;
}

export interface FeedCommentAttempt {
  token: number;
  instanceId: string;
  articleId: string;
  parentId: string;
  revision: number;
  intentId: number;
  content: string;
  requestId: string;
}

export interface FeedCommentSuccess {
  parentId: string;
  pending: boolean;
  commentId: string;
}

export interface FeedCommentCardState {
  mounted: boolean;
  instanceId: string;
  articleId: string;
  currentUserId: string;
  expanded: boolean;
  preview: FeedCommentPreviewItem[] | null;
  visibleReplyCount: number | null;
  activeParentId: string | null;
  drafts: Record<string, FeedCommentDraft>;
  attempt: FeedCommentAttempt | null;
  nextAttemptToken: number;
  nextIntentId: number;
  success: FeedCommentSuccess | null;
}

export type FeedCommentAction =
  | { type: "open"; parentId: string }
  | { type: "cancel" }
  | { type: "setExpanded"; expanded: boolean }
  | { type: "edit"; parentId: string; text: string }
  | { type: "begin"; parentId: string; requestId: string }
  | { type: "succeed"; attempt: FeedCommentAttempt; comment: FeedCommentPreviewItem }
  | { type: "fail"; attempt: FeedCommentAttempt; error: Omit<FeedCommentUiError, "revision" | "content"> }
  | { type: "watchdog"; attempt: FeedCommentAttempt }
  | { type: "confirmPresent"; parentId: string }
  | { type: "confirmAbsent"; parentId: string }
  | { type: "confirmParentContext"; parentId: string }
  // No `confirmLogin`: logging in means a full page reload, which builds fresh
  // state, and the submit gate already allows a retry while the error stands.
  | { type: "unmount" };

export function createFeedCommentCardState(input: {
  instanceId: string;
  articleId: string;
  currentUserId?: string;
  commentPreview: FeedCommentPreviewItem[] | null;
  visibleReplyCount: number | null;
}): FeedCommentCardState {
  return {
    mounted: true,
    instanceId: input.instanceId,
    articleId: input.articleId,
    currentUserId: input.currentUserId ?? "",
    expanded: input.commentPreview === null || input.commentPreview.length > 0,
    preview: input.commentPreview,
    visibleReplyCount: input.visibleReplyCount,
    activeParentId: null,
    drafts: {},
    attempt: null,
    nextAttemptToken: 1,
    nextIntentId: 1,
    success: null,
  };
}

function draftFor(
  state: FeedCommentCardState,
  parentId: string,
): FeedCommentDraft {
  return state.drafts[parentId] ?? {
    text: "",
    revision: 0,
    intentId: state.nextIntentId,
    retries: {},
    retryReady: {},
    error: null,
  };
}

function withDraft(
  state: FeedCommentCardState,
  parentId: string,
  draft: FeedCommentDraft,
  created: boolean,
): FeedCommentCardState {
  return {
    ...state,
    drafts: { ...state.drafts, [parentId]: draft },
    nextIntentId: created ? state.nextIntentId + 1 : state.nextIntentId,
  };
}

export function sameFeedCommentAttempt(
  current: FeedCommentAttempt | null,
  candidate: FeedCommentAttempt,
): boolean {
  return current !== null &&
    current.token === candidate.token &&
    current.instanceId === candidate.instanceId &&
    current.articleId === candidate.articleId &&
    current.parentId === candidate.parentId &&
    current.revision === candidate.revision &&
    current.intentId === candidate.intentId &&
    current.content === candidate.content &&
    current.requestId === candidate.requestId;
}

function unknownError(
  category: FeedCommentUiError["category"],
  requestId?: string,
): Omit<FeedCommentUiError, "revision" | "content"> {
  return {
    code: "comment.outcome_unknown",
    category,
    requestId,
  };
}

export function reduceFeedCommentState(
  state: FeedCommentCardState,
  action: FeedCommentAction,
): FeedCommentCardState {
  if (!state.mounted) return state;

  switch (action.type) {
    case "unmount":
      return { ...state, mounted: false, attempt: null, activeParentId: null };
    case "open":
      if (state.attempt) return state;
      return {
        ...withDraft(state, action.parentId, draftFor(state, action.parentId), !state.drafts[action.parentId]),
        activeParentId: action.parentId,
        success: null,
      };
    case "cancel":
      if (state.attempt) return state;
      return { ...state, activeParentId: null, success: null };
    case "setExpanded":
      if (state.attempt) return state;
      return {
        ...state,
        expanded: action.expanded,
        activeParentId: action.expanded ? state.activeParentId : null,
      };
    case "edit": {
      if (state.attempt) return state;
      const previous = draftFor(state, action.parentId);
      const draft: FeedCommentDraft = {
        ...previous,
        text: action.text,
        revision: previous.revision + 1,
      };
      return withDraft(state, action.parentId, draft, !state.drafts[action.parentId]);
    }
    case "begin": {
      if (state.attempt || !state.mounted) return state;
      const draft = state.drafts[action.parentId];
      if (!draft) return state;
      const validated = validateFeedCommentText(draft.text);
      if (!validated.ok) return state;
      const attempt: FeedCommentAttempt = {
        token: state.nextAttemptToken,
        instanceId: state.instanceId,
        articleId: state.articleId,
        parentId: action.parentId,
        revision: draft.revision,
        intentId: draft.intentId,
        content: validated.value,
        requestId: action.requestId,
      };
      return {
        ...state,
        activeParentId: action.parentId,
        nextAttemptToken: state.nextAttemptToken + 1,
        attempt,
        success: null,
        drafts: {
          ...state.drafts,
          [action.parentId]: { ...draft, text: validated.value, error: null },
        },
      };
    }
    case "succeed": {
      if (!sameFeedCommentAttempt(state.attempt, action.attempt)) return state;
      const draft = state.drafts[action.attempt.parentId];
      if (!draft || draft.revision !== action.attempt.revision) return state;
      if (action.comment.articleId !== state.articleId ||
          action.comment.parentId !== action.attempt.parentId ||
          action.comment.content !== action.attempt.content) return state;
      const drafts = { ...state.drafts };
      delete drafts[action.attempt.parentId];
      const duplicate = state.preview?.some((comment) => comment.id === action.comment.id) ?? false;
      return {
        ...state,
        preview: state.preview === null
          ? null
          : duplicate ? state.preview : [...state.preview, action.comment],
        visibleReplyCount: state.visibleReplyCount === null || duplicate
          ? state.visibleReplyCount
          : state.visibleReplyCount + 1,
        drafts,
        activeParentId: null,
        attempt: null,
        success: {
          parentId: action.attempt.parentId,
          pending: action.comment.status === "pending_review",
          commentId: action.comment.id,
        },
      };
    }
    case "fail":
    case "watchdog": {
      if (!sameFeedCommentAttempt(state.attempt, action.attempt)) return state;
      const parentId = action.attempt.parentId;
      const draft = state.drafts[parentId];
      if (!draft || draft.revision !== action.attempt.revision) return state;
      const baseError = action.type === "watchdog"
        ? unknownError("watchdog", action.attempt.requestId)
        : action.error;
      const category = retryCategory(baseError.code);
      const manualRetry = category && draft.retryReady[category] === true;
      const retries = { ...draft.retries };
      if (category && manualRetry) retries[category] = (retries[category] ?? 0) + 1;
      return {
        ...state,
        attempt: null,
        drafts: {
          ...state.drafts,
          [parentId]: {
            ...draft,
            retries,
            retryReady: category
              ? {
                  ...draft.retryReady,
                  // Rate limits need no separate detail confirmation; their first
                  // retry is unlocked by Retry-After, then counted on recurrence.
                  [category]: category === "rate_limited" ? true : undefined,
                }
              : draft.retryReady,
            error: { ...baseError, revision: draft.revision, content: action.attempt.content },
          },
        },
      };
    }
    case "confirmPresent": {
      const draft = state.drafts[action.parentId];
      if (state.attempt || draft?.error?.code !== "comment.outcome_unknown") return state;
      if (draft.revision !== draft.error.revision) {
        return withDraft(state, action.parentId, { ...draft, error: null }, false);
      }
      const drafts = { ...state.drafts };
      delete drafts[action.parentId];
      return {
        ...state,
        drafts,
        activeParentId: null,
        success: null,
      };
    }
    case "confirmAbsent":
    case "confirmParentContext": {
      const draft = state.drafts[action.parentId];
      const expected = action.type === "confirmAbsent"
        ? "comment.outcome_unknown"
        : "comment.parent_conflict";
      const category: FeedCommentRetryCategory = action.type === "confirmAbsent"
        ? "outcome_unknown"
        : "parent_conflict";
      if (state.attempt || draft?.error?.code !== expected) return state;
      return withDraft(state, action.parentId, {
        ...draft,
        retryReady: { ...draft.retryReady, [category]: true },
      }, false);
    }
  }
}

export function retryCategory(code: FeedCommentErrorCode): FeedCommentRetryCategory | null {
  if (code === "comment.rate_limited") return "rate_limited";
  if (code === "comment.outcome_unknown") return "outcome_unknown";
  if (code === "comment.parent_conflict") return "parent_conflict";
  return null;
}

export type FeedCommentSubmitGate =
  | { ok: true; reason?: undefined }
  | { ok: false; reason: "invalid" | "submitting" | "terminal" | "detail_check" | "wait" | "forbidden" };

export function feedCommentSubmitGate(
  state: FeedCommentCardState,
  parentId: string,
  now = Date.now(),
): FeedCommentSubmitGate {
  if (state.attempt || !state.mounted) return { ok: false, reason: "submitting" };
  const draft = state.drafts[parentId];
  if (!draft || !validateFeedCommentText(draft.text).ok) return { ok: false, reason: "invalid" };
  const error = draft.error;
  if (!error) return { ok: true };
  const category = retryCategory(error.code);
  if (category) {
    if ((draft.retries[category] ?? 0) >= 1) return { ok: false, reason: "terminal" };
    if (category === "outcome_unknown" && !draft.retryReady[category]) {
      return { ok: false, reason: "detail_check" };
    }
    if (category === "parent_conflict" && !draft.retryReady[category]) {
      return { ok: false, reason: "detail_check" };
    }
    if (category === "rate_limited" && error.retryAtMs !== undefined && now < error.retryAtMs) {
      return { ok: false, reason: "wait" };
    }
    return { ok: true };
  }
  if (error.code === "comment.invalid_input" ||
      error.code === "comment.invalid_json" ||
      error.code === "comment.moderation_rejected") {
    return draft.revision > error.revision ? { ok: true } : { ok: false, reason: "invalid" };
  }
  if (error.code === "comment.unauthenticated") return { ok: true };
  return { ok: false, reason: "forbidden" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A syntactically valid 201 is not enough: it must describe this exact write. */
export function parseFeedCommentCreated(
  value: unknown,
  attempt: FeedCommentAttempt,
  currentUserId: string,
): FeedCommentPreviewItem | null {
  if (!isRecord(value) || !nonEmptyString(value.id) ||
      value.articleId !== attempt.articleId || value.parentId !== attempt.parentId ||
      value.content !== attempt.content || !nonEmptyString(value.createdAt) ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      !Array.isArray(value.images) || value.images.length !== 0 ||
      typeof value.pendingReview !== "boolean" ||
      (value.status !== "published" && value.status !== "pending_review") ||
      value.pendingReview !== (value.status === "pending_review") ||
      !isRecord(value.author) || value.author.id !== currentUserId ||
      !nonEmptyString(value.author.username)) return null;
  return {
    id: value.id,
    articleId: attempt.articleId,
    parentId: attempt.parentId,
    content: attempt.content,
    contentTruncated: false,
    status: value.status,
    origin: typeof value.origin === "string" ? value.origin : null,
    createdAt: value.createdAt,
    author: {
      id: currentUserId,
      username: value.author.username,
      avatar: typeof value.author.avatar === "string" ? value.author.avatar : null,
      level: typeof value.author.level === "number" && Number.isFinite(value.author.level)
        ? value.author.level
        : 0,
    },
  };
}

export function parseFeedCommentProblem(value: unknown): FeedCommentProblem | null {
  if (!isRecord(value) || !isFeedCommentErrorCode(value.code) ||
      !nonEmptyString(value.type) || !value.type.startsWith("urn:puer:comment:") ||
      !nonEmptyString(value.detail) || !nonEmptyString(value.requestId) ||
      typeof value.status !== "number" || typeof value.retryable !== "boolean" ||
      (value.sideEffects !== "none" && value.sideEffects !== "unknown") ||
      (value.manualRetryLimit !== 0 && value.manualRetryLimit !== 1) ||
      !["edit", "login", "detail", "retry", "none"].includes(String(value.recovery))) return null;
  return value as unknown as FeedCommentProblem;
}

export function parseRetryAfter(
  header: string | null,
  now: number,
): { retryAtMs?: number; retryAfterSeconds?: number } {
  if (!header) return {};
  const trimmed = header.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds)) {
      return { retryAtMs: now + seconds * 1000, retryAfterSeconds: Math.ceil(seconds) };
    }
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? { retryAtMs: date } : {};
}

/** Flat storage, tree rendering. Every descendant gets the same one visual indent. */
export function flattenFeedCommentPreview(
  preview: readonly FeedCommentPreviewItem[] | null,
): Array<{ comment: FeedCommentPreviewItem; nested: boolean }> {
  if (!preview) return [];
  const children = new Map<string, FeedCommentPreviewItem[]>();
  const roots: FeedCommentPreviewItem[] = [];
  for (const comment of preview) {
    if (comment.parentId === null) roots.push(comment);
    else {
      const list = children.get(comment.parentId) ?? [];
      list.push(comment);
      children.set(comment.parentId, list);
    }
  }
  const rows: Array<{ comment: FeedCommentPreviewItem; nested: boolean }> = [];
  const visited = new Set<string>();
  const append = (comment: FeedCommentPreviewItem, nested: boolean) => {
    if (visited.has(comment.id)) return;
    visited.add(comment.id);
    rows.push({ comment, nested });
    for (const child of children.get(comment.id) ?? []) append(child, true);
  };
  for (const root of roots) append(root, false);
  // An unexpected orphan remains visible and replyable instead of disappearing locally.
  for (const comment of preview) append(comment, comment.parentId !== null);
  return rows;
}

export function buildFeedReplyReturnPath(
  pathname: string,
  currentSearch: string,
  articleId: string,
  parentId: string,
): string {
  const safePath = pathname.startsWith("/") && !pathname.startsWith("//") &&
    !pathname.includes("\\") && !pathname.includes(":") ? pathname : "/forum";
  const params = new URLSearchParams(currentSearch);
  params.set("feedArticle", articleId);
  params.set("feedReply", parentId);
  return `${safePath}?${params.toString()}#post-${articleId}`;
}

export function feedReplyIntent(search: string): { articleId: string; parentId: string } | null {
  const params = new URLSearchParams(search);
  const articleId = params.get("feedArticle");
  const parentId = params.get("feedReply");
  return articleId && parentId ? { articleId, parentId } : null;
}

export interface FeedCommentFetchInput {
  articleId: string;
  parentId: string;
  content: string;
  requestId: string;
  signal: AbortSignal;
}

export interface FeedCommentControllerDeps {
  fetcher: (input: FeedCommentFetchInput) => Promise<Response>;
  now: () => number;
  requestId: () => string;
  /** Starts the 60-second watchdog and returns its cancellation function. */
  watchdog: (callback: () => void, delayMs: number) => () => void;
  onChange: (state: FeedCommentCardState) => void;
}

/** Framework-neutral async coordinator; React only owns focus and rendering. */
export class FeedCommentController {
  private state: FeedCommentCardState;
  private readonly deps: FeedCommentControllerDeps;
  private readonly aborts = new Map<number, AbortController>();

  constructor(initial: FeedCommentCardState, deps: FeedCommentControllerDeps) {
    this.state = initial;
    this.deps = deps;
  }

  getState(): FeedCommentCardState {
    return this.state;
  }

  /** React StrictMode replays effect cleanup/setup without a real DOM unmount. */
  mount(): void {
    if (!this.state.mounted) this.state = { ...this.state, mounted: true };
  }

  dispatch(action: FeedCommentAction): FeedCommentCardState {
    this.state = reduceFeedCommentState(this.state, action);
    if (this.state.mounted) this.deps.onChange(this.state);
    if (action.type === "unmount") {
      for (const controller of this.aborts.values()) controller.abort();
      this.aborts.clear();
    }
    return this.state;
  }

  async submit(parentId: string): Promise<boolean> {
    const gate = feedCommentSubmitGate(this.state, parentId, this.deps.now());
    if (!gate.ok) return false;
    const requestId = this.deps.requestId();
    const before = this.dispatch({ type: "begin", parentId, requestId });
    const attempt = before.attempt;
    if (!attempt || attempt.requestId !== requestId) return false;

    const abort = new AbortController();
    this.aborts.set(attempt.token, abort);
    const cancelWatchdog = this.deps.watchdog(() => {
      this.dispatch({ type: "watchdog", attempt });
      abort.abort();
    }, FEED_COMMENT_LIMITS.watchdogMs);

    try {
      const response = await this.deps.fetcher({
        articleId: attempt.articleId,
        parentId: attempt.parentId,
        content: attempt.content,
        requestId,
        signal: abort.signal,
      });
      if (response.status === 201) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          this.dispatch({
            type: "fail",
            attempt,
            error: unknownError("bad_success", requestId),
          });
          return false;
        }
        const comment = parseFeedCommentCreated(body, attempt, this.state.currentUserId);
        if (!comment) {
          this.dispatch({
            type: "fail",
            attempt,
            error: unknownError("bad_success", requestId),
          });
          return false;
        }
        const next = this.dispatch({ type: "succeed", attempt, comment });
        return next.success?.commentId === comment.id;
      }

      let problem: FeedCommentProblem | null = null;
      try {
        problem = parseFeedCommentProblem(await response.json());
      } catch {
        // A non-contract response cannot prove that creation did not happen.
      }
      // Only a problem that provably describes THIS attempt may be treated as a
      // definite failure. A stale/mismatched 4xx would otherwise reopen the
      // edit or retry path and risk a duplicate reply.
      const definite = problem !== null && response.status >= 400 && response.status < 500 &&
        problem.code !== "comment.outcome_unknown" &&
        problem.requestId === requestId &&
        problem.status === response.status &&
        problem.sideEffects === "none";
      const error = definite && problem !== null
        ? {
            code: problem.code,
            category: "http" as const,
            detail: problem.detail.slice(0, 500),
            requestId: problem.requestId,
            ...(problem.code === "comment.rate_limited"
              ? parseRetryAfter(response.headers.get("retry-after"), this.deps.now())
              : {}),
          }
        : unknownError("http", problem?.requestId ?? requestId);
      this.dispatch({ type: "fail", attempt, error });
      return false;
    } catch {
      this.dispatch({ type: "fail", attempt, error: unknownError("network", requestId) });
      return false;
    } finally {
      cancelWatchdog();
      this.aborts.delete(attempt.token);
    }
  }
}
