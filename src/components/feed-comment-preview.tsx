"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import OriginDisclosure from "@/components/article/origin-disclosure";
import { useLocale } from "@/i18n/context";
import {
  FEED_COMMENT_LIMITS,
  validateFeedCommentText,
  type FeedCommentErrorCode,
  type FeedCommentPreviewItem,
} from "@/lib/feed-comment-contract";
import {
  FeedCommentController,
  buildFeedReplyReturnPath,
  createFeedCommentCardState,
  feedCommentSubmitGate,
  feedReplyIntent,
  flattenFeedCommentPreview,
  newFeedCommentRequestId,
  type FeedCommentUiError,
} from "@/lib/feed-comment-state";

const ERROR_TEXT: Record<FeedCommentErrorCode, string> = {
  "comment.invalid_json": "请求不是有效的 JSON",
  "comment.invalid_input": "评论内容或目标不符合要求",
  "comment.parent_conflict": "讨论已变化，请到详情确认后回复",
  "comment.unauthenticated": "登录状态已失效；登录后回到此页手动发布",
  "comment.forbidden": "当前账号暂时不能发表评论",
  "comment.rate_limited": "评论过于频繁，请稍后再试",
  "comment.feed_disabled": "首页内联回复暂不可用",
  "comment.moderation_rejected": "内容含违规信息，无法发布",
  "comment.outcome_unknown": "结果未知，可能已发布；请先在详情核对",
};

function relativeTime(value: string, locale: string, translate: (text: string) => string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return translate("刚刚");
  if (minutes < 60) return `${minutes} ${translate("分钟前")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${translate("小时前")}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${translate("天前")}`;
  return new Date(value).toLocaleDateString(locale === "zh-TW" ? "zh-TW" : "zh-CN");
}

function feedLoginHref(returnPath: string): string {
  return `/login?next=${encodeURIComponent(returnPath)}`;
}

export default function FeedCommentPreview({
  articleId,
  currentUserId,
  commentPreview,
  visibleReplyCount,
  detailHref,
  commentLoadId,
  onVisibleCountChange,
}: {
  articleId: string;
  currentUserId?: string;
  commentPreview: FeedCommentPreviewItem[] | null;
  visibleReplyCount: number | null;
  detailHref: string;
  commentLoadId: string;
  /** Keeps the card's comment chip in step with the live preview header. */
  onVisibleCountChange?: (count: number | null) => void;
}) {
  const { _, locale } = useLocale();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const instanceId = useId();
  const [state, setState] = useState(() => createFeedCommentCardState({
    instanceId,
    articleId,
    currentUserId,
    commentPreview,
    visibleReplyCount,
  }));
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const expandRef = useRef<HTMLButtonElement | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);
  const successRef = useRef<HTMLDivElement | null>(null);
  const replyRefs = useRef(new Map<string, HTMLButtonElement>());
  const handledIntentRef = useRef(false);
  const [intentDismissed, setIntentDismissed] = useState(false);
  const [shortcutMessage, setShortcutMessage] = useState("");

  // One controller owns the synchronous submission lock and all async completions.
  // Lazy state initialization creates it once without reading a ref during render.
  const [controller] = useState(() => new FeedCommentController(state, {
    fetcher: async (input) => fetch("/api/comments", {
      method: "POST",
      headers: {
        "Accept": "application/problem+json",
        "Content-Type": "application/json",
        "X-Request-ID": input.requestId,
      },
      body: JSON.stringify({
        articleId: input.articleId,
        parentId: input.parentId,
        content: input.content,
        images: [],
        surface: "feed",
      }),
      signal: input.signal,
    }),
    now: () => Date.now(),
    requestId: newFeedCommentRequestId,
    watchdog: (callback, delayMs) => {
      const timer = window.setTimeout(callback, delayMs);
      return () => window.clearTimeout(timer);
    },
    onChange: (next) => setState(next),
  }));

  const replyIntent = feedReplyIntent(searchParams.toString());
  const missingIntent = !intentDismissed && Boolean(currentUserId) &&
    state.preview !== null &&
    replyIntent?.articleId === articleId &&
    !state.preview.some((comment) => comment.id === replyIntent.parentId);
  const rows = flattenFeedCommentPreview(state.preview);
  const activeParentId = state.activeParentId;
  const activeDraft = activeParentId ? state.drafts[activeParentId] : null;
  const activeError = activeDraft?.error ?? null;
  const submitting = state.attempt !== null;
  const countLabel = state.visibleReplyCount === null
    ? _("查看全部回复")
    : `${_("查看全部")} ${state.visibleReplyCount} ${_("条回复")}`;

  // The comment chip sits outside this section, in the card's action row. Without
  // this the chip keeps the SSR count while the header increments on a new reply,
  // so one card shows two different numbers.
  const notifyVisibleCount = onVisibleCountChange;
  useEffect(() => {
    notifyVisibleCount?.(state.visibleReplyCount);
  }, [notifyVisibleCount, state.visibleReplyCount]);

  useEffect(() => {
    controller.mount();
    return () => { controller.dispatch({ type: "unmount" }); };
  }, [controller]);

  useEffect(() => {
    if (handledIntentRef.current || !currentUserId) return;
    handledIntentRef.current = true;
    if (!replyIntent || replyIntent.articleId !== articleId) return;
    if (state.preview?.some((comment) => comment.id === replyIntent.parentId)) {
      controller.dispatch({ type: "open", parentId: replyIntent.parentId });
    }
  }, [articleId, controller, currentUserId, replyIntent, state.preview]);

  useEffect(() => {
    if (activeParentId && !submitting && !activeError) textareaRef.current?.focus();
  }, [activeParentId, activeError, submitting]);

  useEffect(() => {
    if (activeError) errorRef.current?.focus();
  }, [activeError]);

  useEffect(() => {
    if (state.success) successRef.current?.focus();
  }, [state.success]);

  function openReply(parentId: string) {
    if (!currentUserId) return;
    setIntentDismissed(true);
    controller.dispatch({ type: "open", parentId });
    if (controller.getState().activeParentId === parentId) textareaRef.current?.focus();
  }

  function cancelReply(parentId: string) {
    if (controller.getState().attempt) {
      setShortcutMessage(_("正在发布，请等待结果；取消不会撤回服务端请求"));
      return;
    }
    replyRefs.current.get(parentId)?.focus();
    controller.dispatch({ type: "cancel" });
  }

  function toggleExpanded() {
    if (controller.getState().attempt) return;
    if (state.expanded) expandRef.current?.focus();
    controller.dispatch({ type: "setExpanded", expanded: !state.expanded });
  }

  async function submit(parentId: string) {
    setShortcutMessage("");
    const accepted = await controller.submit(parentId);
    if (!accepted && controller.getState().mounted) {
      const gate = feedCommentSubmitGate(controller.getState(), parentId);
      if (gate.reason === "wait") setShortcutMessage(_("尚未到达服务端指定的重试时间"));
    }
  }

  /**
   * Reconciliation buttons remove focus from the DOM (the error block closes),
   * so move it deliberately: back into the draft when it survives, otherwise to
   * the parent comment's reply button.
   */
  function reconcile(action: {
    type: "confirmPresent" | "confirmAbsent" | "confirmParentContext";
    parentId: string;
  }) {
    const draft = controller.getState().drafts[action.parentId];
    const editorSurvives = action.type !== "confirmPresent" ||
      (draft !== undefined && draft.error !== null && draft.revision !== draft.error.revision);
    controller.dispatch(action);
    requestAnimationFrame(() => {
      if (editorSurvives) textareaRef.current?.focus();
      else replyRefs.current.get(action.parentId)?.focus();
    });
  }

  function errorActions(parentId: string, error: FeedCommentUiError) {
    const draft = state.drafts[parentId];
    // The text moved on after the failure: "确认已发布" no longer discards the
    // text the user is looking at, so the label must not promise that it does.
    const editedSinceError = draft !== undefined && draft.error !== null &&
      draft.revision !== draft.error.revision;
    const detailLink = (
      <Link href={detailHref} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm font-medium text-amber-800 underline underline-offset-2">
        {_("在新标签页打开详情核对")} ↗
      </Link>
    );
    if (error.code === "comment.outcome_unknown") {
      const ready = state.drafts[parentId]?.retryReady.outcome_unknown;
      const terminal = feedCommentSubmitGate(state, parentId).reason === "terminal";
      return (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {detailLink}
          {!terminal && !ready && (
            <>
              <button type="button" className="min-h-11 px-2 text-sm text-stone-700 underline" onClick={() => reconcile({ type: "confirmPresent", parentId })}>
                {editedSinceError ? _("确认已发布，只清除这条提示") : _("确认已发布，清除这份草稿")}
              </button>
              <button type="button" className="min-h-11 px-2 text-sm text-stone-700 underline" onClick={() => reconcile({ type: "confirmAbsent", parentId })}>
                {_("确认未发布，允许手动重试")}
              </button>
            </>
          )}
          {ready && !terminal && <span className="text-sm text-stone-600">{_("已确认未发布，请手动点击发布")}</span>}
          {terminal && <span className="text-sm text-stone-600">{_("已达到人工重试上限，请在详情继续处理")}</span>}
        </div>
      );
    }
    if (error.code === "comment.parent_conflict") {
      const ready = state.drafts[parentId]?.retryReady.parent_conflict;
      const terminal = feedCommentSubmitGate(state, parentId).reason === "terminal";
      return (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {detailLink}
          {!ready && !terminal && (
            <button type="button" className="min-h-11 px-2 text-sm text-stone-700 underline" onClick={() => reconcile({ type: "confirmParentContext", parentId })}>
              {_("已核对详情，允许一次重试")}
            </button>
          )}
          {ready && !terminal && <span className="text-sm text-stone-600">{_("已确认讨论上下文，请手动点击发布")}</span>}
          {terminal && <span className="text-sm text-stone-600">{_("已达到人工重试上限，请在详情继续处理")}</span>}
        </div>
      );
    }
    if (error.code === "comment.unauthenticated") {
      const loginPath = buildFeedReplyReturnPath(pathname, searchParams.toString(), articleId, parentId);
      return (
        <div className="mt-2">
          <Link href={feedLoginHref(loginPath)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm font-medium text-amber-800 underline">
            {_("在新标签页登录，回来后手动发布")} ↗
          </Link>
        </div>
      );
    }
    if (error.code === "comment.feed_disabled" || error.code === "comment.forbidden" ||
        feedCommentSubmitGate(state, parentId).reason === "terminal") {
      return <div className="mt-2">{detailLink}</div>;
    }
    return null;
  }

  function editor(parent: FeedCommentPreviewItem) {
    const parentId = parent.id;
    const draft = state.drafts[parentId];
    if (!draft || activeParentId !== parentId) return null;
    const validation = validateFeedCommentText(draft.text);
    const units = validation.units;
    const gate = feedCommentSubmitGate(state, parentId);
    const disabled = submitting || !validation.ok ||
      gate.reason === "terminal" || gate.reason === "detail_check" ||
      gate.reason === "forbidden" || gate.reason === "invalid";
    const hintId = `feed-comment-hint-${articleId}-${parentId}`;
    const errorId = `feed-comment-error-${articleId}-${parentId}`;
    return (
      <form
        className="mt-2 rounded-md border border-stone-200 bg-stone-50 p-3"
        onSubmit={(event) => { event.preventDefault(); void submit(parentId); }}
      >
        <label htmlFor={`feed-comment-input-${articleId}-${parentId}`} className="block text-sm font-medium text-stone-700">
          {_("回复")} @{parent.author.username}
        </label>
        <textarea
          id={`feed-comment-input-${articleId}-${parentId}`}
          ref={textareaRef}
          value={draft.text}
          readOnly={submitting}
          rows={3}
          maxLength={FEED_COMMENT_LIMITS.maxTextUnits + 500}
          aria-describedby={`${hintId}${draft.error ? ` ${errorId}` : ""}`}
          aria-invalid={draft.error?.code === "comment.invalid_input" || draft.error?.code === "comment.moderation_rejected"}
          onChange={(event) => controller.dispatch({ type: "edit", parentId, text: event.target.value })}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              if (validateFeedCommentText(draft.text).ok) void submit(parentId);
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelReply(parentId);
            }
          }}
          className="mt-2 max-h-48 min-h-24 w-full resize-y rounded-md border border-stone-300 bg-white px-3 py-2 text-base leading-relaxed text-stone-800 outline-none focus:border-amber-700 focus:ring-2 focus:ring-amber-700/25"
          placeholder={_("写下你的回复…")}
        />
        <div id={hintId} className={`mt-1 text-xs ${validation.ok ? "text-stone-500" : "text-amber-800"}`}>
          {units < FEED_COMMENT_LIMITS.minTextUnits
            ? `${_("评论至少 5 个字")} · ${_("当前")} ${units} ${_("字")}`
            : units > FEED_COMMENT_LIMITS.maxTextUnits
              ? `${_("已超出")} ${units - FEED_COMMENT_LIMITS.maxTextUnits} ${_("字")}`
              : `${_("还可输入")} ${FEED_COMMENT_LIMITS.maxTextUnits - units} ${_("字")} · Cmd/Ctrl+Enter ${_("发布")}`}
        </div>
        {draft.error && (
          <div id={errorId} ref={errorRef} tabIndex={-1} role="alert" className="mt-2 rounded-md bg-white p-2 text-sm text-stone-700 outline-none focus:ring-2 focus:ring-amber-700/25">
            <p>{_(ERROR_TEXT[draft.error.code])}</p>
            {draft.error.retryAfterSeconds !== undefined && (
              <p className="mt-1">{_("服务端要求等待")} {draft.error.retryAfterSeconds} {_("秒后可手动重试")}</p>
            )}
            {draft.error.requestId && <p className="mt-1 break-all text-xs text-stone-500">Request ID: {draft.error.requestId}</p>}
            {errorActions(parentId, draft.error)}
          </div>
        )}
        <div className="mt-2 flex items-center gap-2">
          <button
            type="submit"
            disabled={disabled}
            className="min-h-11 rounded-md bg-amber-700 px-4 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:bg-stone-300"
          >
            {submitting ? _("发布中…") : draft.error?.code === "comment.rate_limited" ? _("手动重试") : _("发布回复")}
          </button>
          <button type="button" disabled={submitting} onClick={() => cancelReply(parentId)} className="min-h-11 px-3 text-sm text-stone-600 hover:text-stone-900 disabled:text-stone-400">
            {_("取消")}
          </button>
        </div>
      </form>
    );
  }

  if (state.preview !== null && state.preview.length === 0 && state.visibleReplyCount === 0 && !missingIntent) {
    return null;
  }

  return (
    <section
      aria-label={_("讨论预览")}
      data-comment-load-id={commentLoadId}
      className="border-t border-stone-100 bg-stone-50/60 px-3 py-2 md:px-4"
    >
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs font-medium text-stone-500">{_("讨论预览")}</span>
        <Link href={detailHref} className="inline-flex min-h-11 items-center text-xs font-medium text-amber-800 hover:text-amber-900">
          {countLabel} ↗
        </Link>
        {state.preview !== null && state.preview.length > 0 && (
          <button
            ref={expandRef}
            type="button"
            disabled={submitting}
            aria-expanded={state.expanded}
            aria-controls={`feed-comments-${articleId}`}
            onClick={toggleExpanded}
            className="ml-auto min-h-11 min-w-11 px-2 text-xs text-stone-600 hover:text-stone-900 disabled:text-stone-400"
          >
            {state.expanded ? _("收起 ▲") : _("展开 ▼")}
          </button>
        )}
      </div>

      {missingIntent && (
        <div role="status" className="pb-2 text-sm text-stone-600">
          {_("这条评论已不在当前预览中，请到详情查看并回复。")}{" "}
          <Link href={detailHref} className="inline-flex min-h-11 items-center text-amber-800 underline">{_("查看全部回复")} ↗</Link>
        </div>
      )}

      {state.preview === null ? (
        <p role="status" className="pb-2 text-sm text-stone-600">{_("讨论暂时无法加载，请通过详情查看。")}</p>
      ) : rows.length === 0 ? (
        <p className="pb-2 text-sm text-stone-600">{_("当前没有可预览的顶层回复，完整讨论请见详情。")}</p>
      ) : state.expanded ? (
        <div id={`feed-comments-${articleId}`} className="space-y-2 pb-1">
          {rows.map(({ comment, nested }) => (
            <article key={comment.id} className={nested ? "ml-4 border-l-2 border-stone-200 pl-3" : ""}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500">
                <Link href={`/user/${comment.author.id}`} className="inline-flex min-h-11 items-center font-medium text-stone-700 hover:text-amber-800">
                  {comment.author.username}
                </Link>
                <span suppressHydrationWarning>{relativeTime(comment.createdAt, locale, _)}</span>
                <OriginDisclosure origin={comment.origin} variant="comment" translate={_} />
                {comment.status === "pending_review" && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">
                    {comment.author.id === currentUserId ? _("审核中，仅你可见") : _("审核中")}
                  </span>
                )}
              </div>
              {/* Deliberately smaller than the post body (text-xs md:text-sm): a
                  preview must not outshout the content it previews. */}
              <p className="line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-stone-600 md:text-sm [overflow-wrap:anywhere]">
                {comment.content}{comment.contentTruncated ? "…" : ""}
              </p>
              <div className="flex flex-wrap items-center gap-x-3">
                {currentUserId ? (
                  <button
                    ref={(element) => {
                      if (element) replyRefs.current.set(comment.id, element);
                      else replyRefs.current.delete(comment.id);
                    }}
                    type="button"
                    disabled={submitting}
                    onClick={() => openReply(comment.id)}
                    className="min-h-11 min-w-11 px-2 text-xs font-medium text-amber-800 hover:text-amber-900 disabled:text-stone-400"
                  >
                    {_("回复")}
                  </button>
                ) : (
                  <Link
                    href={feedLoginHref(buildFeedReplyReturnPath(pathname, searchParams.toString(), articleId, comment.id))}
                    className="inline-flex min-h-11 items-center px-2 text-xs font-medium text-amber-800"
                  >
                    {_("登录后回复")}
                  </Link>
                )}
              </div>
              {editor(comment)}
              {state.success?.parentId === comment.id && (
                <div ref={successRef} tabIndex={-1} role="status" className="my-2 rounded-md bg-amber-50 p-2 text-sm text-stone-700 outline-none focus:ring-2 focus:ring-amber-700/25">
                  {state.success.pending ? _("审核中，仅你可见。") : _("已发布到该评论下。")}{" "}
                  <Link href={detailHref} className="inline-flex min-h-11 items-center text-amber-800 underline">{_("查看详情")} ↗</Link>
                </div>
              )}
            </article>
          ))}
        </div>
      ) : null}
      <div aria-live="polite" className={shortcutMessage ? "pb-1 text-sm text-amber-800" : "sr-only"}>{shortcutMessage}</div>
    </section>
  );
}
