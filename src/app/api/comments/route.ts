import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ORIGIN_HUMAN } from "@/lib/content-origin";
import { commentVisibility } from "@/lib/comment-visibility";
import { prisma } from "@/lib/prisma";
import { checkUserCanPost } from "@/lib/check-mute";
import { publishCommentEffects } from "@/lib/comment-effects";
import { checkRateLimit, rateLimitKey, getClientIP, LIMIT_POST } from "@/lib/rate-limit";
import { screenContent } from "@/lib/moderation";
import {
  FEED_COMMENT_LIMITS,
  isFeedInlineRepliesEnabled,
  type FeedCommentProblem,
} from "@/lib/feed-comment-contract";
import {
  FeedBodyError,
  feedLogCategory,
  feedProblem,
  feedRequestId,
  logFeedComment,
  readFeedJsonBody,
  wantsFeedProblem,
  type FeedCommentLogCategory,
} from "@/lib/comment-feed-errors";
import {
  ParentCommentConflict,
  createFeedCommentWithVisibleParent,
  findVisibleArticle,
  findVisibleParent,
  validateFeedCommentPayload,
  type FeedCommentInput,
} from "@/lib/comment-feed-write";

const LEGACY_FEED_STATUS = {
  "comment.invalid_json": 400,
  "comment.invalid_input": 400,
  "comment.parent_conflict": 409,
  "comment.unauthenticated": 401,
  "comment.forbidden": 403,
  "comment.rate_limited": 429,
  "comment.feed_disabled": 404,
  "comment.moderation_rejected": 400,
  "comment.outcome_unknown": 500,
} as const;

const LEGACY_FEED_MESSAGE = {
  "comment.invalid_json": "请求不是有效的 JSON",
  "comment.invalid_input": "评论内容或目标不符合要求",
  "comment.parent_conflict": "讨论已变化，请到详情确认后回复",
  "comment.unauthenticated": "请先登录",
  "comment.forbidden": "当前账号暂时不能发表评论",
  "comment.rate_limited": "评论过于频繁，请稍后再试",
  "comment.feed_disabled": "首页内联回复暂不可用",
  "comment.moderation_rejected": "内容含违规信息，无法发布",
  "comment.outcome_unknown": "结果未知，可能已发布；请先在详情核对",
} as const;

type FeedErrorCode = keyof typeof LEGACY_FEED_STATUS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(req: NextRequest) {
  const problemClient = wantsFeedProblem(req);
  const requestId = feedRequestId(req);
  const gateOn = isFeedInlineRepliesEnabled(process.env.FEED_INLINE_REPLIES);
  let feedSurface = false;
  let target: "article" | "tastingNote" | "unknown" = "unknown";
  let nested = false;
  let commentId: string | undefined;
  let parentAuthorSynthetic: boolean | undefined;

  const feedError = (
    code: FeedErrorCode,
    options: {
      status?: number;
      context?: FeedCommentProblem["context"];
      retryAfterSeconds?: number;
      legacyMessage?: string;
      category?: FeedCommentLogCategory;
    } = {},
  ) => {
    const status = options.status ?? LEGACY_FEED_STATUS[code];
    logFeedComment({
      requestId,
      route: "POST /api/comments",
      // A problem client can post a legacy detail body (or omit `surface`); the
      // failure is then not attributable to inline replies. Without this the
      // feed error dashboard over-counts the new surface.
      surface: feedSurface ? "feed" : "unknown",
      status,
      target,
      gate: gateOn ? "on" : "off",
      nested,
      category: options.category ?? code,
      commentId,
      parentAuthorSynthetic,
    });
    if (problemClient) {
      return feedProblem(code, requestId, options);
    }
    const headers = new Headers({ "X-Request-ID": requestId });
    if (options.retryAfterSeconds !== undefined) {
      headers.set("Retry-After", String(Math.max(1, Math.ceil(options.retryAfterSeconds))));
    }
    return NextResponse.json(
      { error: options.legacyMessage ?? LEGACY_FEED_MESSAGE[code] },
      { status, headers },
    );
  };

  let body: unknown;
  if (problemClient) {
    // Feed clients send a bounded problem+json request. Parse it before auth so
    // a disabled surface is uniformly 404 (it does not become 401 for logged-
    // out probes); legacy detail callers keep their original auth-first order.
    try {
      body = await readFeedJsonBody(req);
    } catch (error) {
      if (error instanceof FeedBodyError) {
        return feedError(error.code, {
          status: error.status,
          context: error.context,
          category: feedLogCategory(error),
        });
      }
      return feedError("comment.invalid_json", { category: "body_read_error" });
    }
    feedSurface = isRecord(body) && body.surface === "feed";
    if (feedSurface && !gateOn) return feedError("comment.feed_disabled");
  } else if (!gateOn) {
    // Accept must not define the surface: a legacy-accept client could otherwise
    // reach the feed write path while the gate is off. Probe a clone so the
    // original body stays readable for the detail path below.
    try {
      const probe = await readFeedJsonBody(req.clone());
      if (isRecord(probe) && probe.surface === "feed") {
        return feedError("comment.feed_disabled");
      }
    } catch {
      // Malformed or oversized bodies fall through: the legacy branch owns that error.
    }
  }

  const session = await auth();
  if (!session?.user) {
    if (problemClient) return feedError("comment.unauthenticated");
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const { canPost, reason } = await checkUserCanPost(session.user.id);
  if (!canPost) {
    if (problemClient) return feedError("comment.forbidden", { legacyMessage: reason });
    return NextResponse.json({ error: reason }, { status: 403 });
  }

  // Rate limit: 10 comments per hour per IP
  const ip = getClientIP(req);
  const rate = checkRateLimit(rateLimitKey(ip, `comment:${session.user.id}`), LIMIT_POST);
  if (!rate.allowed) {
    const retryAfterSeconds = Math.max(1, Math.ceil(rate.resetIn / 1000));
    if (problemClient) return feedError("comment.rate_limited", { retryAfterSeconds });
    return NextResponse.json({ error: "评论过于频繁，请稍后再试" }, { status: 429 });
  }

  if (!problemClient) {
    // Existing detail clients retain their legacy JSON parsing and success shape.
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "请求不是有效的 JSON" }, { status: 400 });
    }
    if (!isRecord(body)) {
      return NextResponse.json({ error: "参数不完整" }, { status: 400 });
    }
    feedSurface = body.surface === "feed";
    if (feedSurface && !gateOn) return feedError("comment.feed_disabled");
  }

  if (feedSurface) {
    const validated = validateFeedCommentPayload(body);
    if (!validated.ok) {
      return feedError(validated.code, { context: validated.context });
    }
    const input: FeedCommentInput = validated.value;
    target = "article";
    // Feed replies always answer an existing comment; there is no root composer.
    nested = true;

    // Cheap pre-check before the moderation call: never spend a moderation
    // request on a write target the actor cannot open. The transaction repeats
    // this check under lock, because visibility can change between the two.
    if (!(await findVisibleArticle(input.articleId, session.user))) {
      return feedError("comment.parent_conflict");
    }

    let mod: Awaited<ReturnType<typeof screenContent>>;
    try {
      mod = await screenContent(input.content);
    } catch {
      return feedError("comment.outcome_unknown", { category: "moderation_error" });
    }
    if (mod.decision === "reject") return feedError("comment.moderation_rejected");
    const isPublish = mod.decision === "publish";
    const moderation = isPublish
      ? undefined
      : { decision: mod.decision, categories: mod.categories, confidence: mod.confidence, reason: mod.reason, source: mod.source };

    let created: Awaited<ReturnType<typeof createFeedCommentWithVisibleParent>>;
    try {
      created = await createFeedCommentWithVisibleParent({
        input,
        actor: session.user,
        publish: isPublish,
        moderation,
      });
      commentId = created.comment.id;
      parentAuthorSynthetic = created.parentAuthorSynthetic;
    } catch (error) {
      if (error instanceof ParentCommentConflict) return feedError("comment.parent_conflict");
      return feedError("comment.outcome_unknown", { category: feedLogCategory(error) });
    }

    if (isPublish) {
      try {
        await publishCommentEffects({
          commentId: created.comment.id,
          authorId: session.user.id,
          articleId: input.articleId,
          tastingNoteId: null,
          parentId: input.parentId,
        });
      } catch {
        return feedError("comment.outcome_unknown", { category: "post_create_effects" });
      }
    }

    logFeedComment({
      requestId,
      route: "POST /api/comments",
      surface: "feed",
      status: 201,
      target,
      gate: "on",
      nested,
      category: isPublish ? "published" : "pending_review",
      commentId,
      authorSynthetic: session.user.isSynthetic,
      parentAuthorSynthetic,
    });
    // Explicit DTO. The Prisma row carries the `moderation` JSON (classifier
    // decision, confidence, provider, reason); spreading it would hand the
    // author of a held comment the reviewer's internals, useful only for
    // probing the filter.
    return NextResponse.json(
      {
        id: created.comment.id,
        articleId: created.comment.articleId,
        parentId: created.comment.parentId,
        content: created.comment.content,
        images: created.comment.images,
        status: created.comment.status,
        origin: created.comment.origin,
        createdAt: created.comment.createdAt,
        author: created.comment.author,
        pendingReview: !isPublish,
      },
      {
        status: 201,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Request-ID": requestId,
        },
      },
    );
  }

  // Problem-mode bodies are parsed above without the legacy isRecord guard, so a
  // literal `null`, array or primitive would reach this destructure and become an
  // unhandled TypeError (500). Reject it as malformed input instead.
  if (!isRecord(body)) {
    return problemClient
      ? feedError("comment.invalid_input")
      : NextResponse.json({ error: "参数不完整" }, { status: 400 });
  }

  // A problem client opted into RFC 9457 for *errors*, so every failure below is
  // answered in that shape. Mixing `{error}` and problem JSON on one endpoint
  // makes a strict client read a definite rejection as `outcome_unknown` (which
  // tells the user their input may already have been published).
  const fail = (
    code: FeedErrorCode,
    status: number,
    legacyMessage: string,
    context?: FeedCommentProblem["context"],
  ) => problemClient
    ? feedError(code, { status, legacyMessage, context })
    : NextResponse.json({ error: legacyMessage }, { status });

  const { articleId, tastingNoteId, content, parentId, images } = body as {
    articleId?: string;
    tastingNoteId?: string;
    content?: string;
    parentId?: string;
    images?: string[];
  };
  // Prisma accepts a filter object where a string id is expected, so
  // `parentId: {"contains":"a"}` turns an equality check into a LIKE and then
  // makes `create` throw an unhandled 500. Type every field before it reaches a
  // query: an untyped id is both a 500 and a "does this comment exist" oracle.
  // The `||` chain also narrows each field for the code below, which a
  // ternaried `badField` discriminator cannot do.
  if (
    typeof content !== "string" ||
    (articleId !== undefined && typeof articleId !== "string") ||
    (tastingNoteId !== undefined && typeof tastingNoteId !== "string") ||
    (parentId !== undefined && parentId !== null && typeof parentId !== "string") ||
    (images !== undefined &&
      (!Array.isArray(images) || images.some((entry) => typeof entry !== "string")))
  ) {
    return fail("comment.invalid_input", 400, "参数不完整");
  }

  if ((!articleId && !tastingNoteId) || !content.trim()) {
    return fail("comment.invalid_input", 400, "参数不完整");
  }

  // Same detail-page policy as GET: a comment on an unreadable article is
  // invisible to its own author and would still fire notifications.
  if (articleId && !(await findVisibleArticle(articleId, session.user))) {
    return fail("comment.parent_conflict", 404, "帖子不存在");
  }

  if (content.trim().length < FEED_COMMENT_LIMITS.minTextUnits) {
    return fail("comment.invalid_input", 400, "评论至少5个字");
  }

  if (parentId) {
    const parent = await findVisibleParent(
      parentId,
      { articleId: articleId ?? null, tastingNoteId: tastingNoteId ?? null },
      session.user,
    );
    if (!parent) {
      return fail("comment.parent_conflict", 409, "父评论不存在、不可见或不属于当前内容");
    }
  }

  // 内容审核:敏感词命中→拒绝;AI 放行→发布;可疑/故障→送审
  const mod = await screenContent(content);
  if (mod.decision === "reject") {
    return fail("comment.moderation_rejected", 400, "内容含违规信息,无法发布");
  }
  const isPublish = mod.decision === "publish";

  const comment = await prisma.comment.create({
    data: {
      ...(articleId ? { articleId } : {}),
      ...(tastingNoteId ? { tastingNoteId } : {}),
      content: content.trim(),
      images: images || [],
      parentId: parentId || null,
      authorId: session.user.id,
      status: isPublish ? "published" : "pending_review",
      // 真人写的评论显式标 human（与 Article.origin 同一套词汇）。
      // AI 回复由 scripts/auto-reply.mjs 写 ai_autonomous。
      origin: ORIGIN_HUMAN,
      // 内联字面量:满足 Prisma Json 字段的索引签名要求
      moderation: isPublish
        ? undefined
        : { decision: mod.decision, categories: mod.categories, confidence: mod.confidence, reason: mod.reason, source: mod.source },
    },
    include: {
      author: { select: { id: true, username: true, avatar: true, level: true } },
    },
  });

  // 仅已发布评论触发副作用(计数/通知/经验);待审评论通过后由审核队列补发。
  if (isPublish) {
    await publishCommentEffects({
      commentId: comment.id,
      authorId: session.user.id,
      articleId,
      tastingNoteId,
      parentId,
    });
  }

  return NextResponse.json({ ...comment, pendingReview: !isPublish }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const articleId = searchParams.get("articleId");
  const tastingNoteId = searchParams.get("tastingNoteId");
  if (!articleId && !tastingNoteId) {
    return NextResponse.json({ error: "缺少 articleId 或 tastingNoteId" }, { status: 400 });
  }

  const session = await auth();
  // The thread page refuses to render an article the viewer cannot open, so its
  // comments must not be readable either. A post that was later made private or
  // pulled for review keeps its already-published comment rows, and its URL
  // survives in shares, search caches and notifications.
  if (articleId && !(await findVisibleArticle(articleId, session?.user))) {
    return NextResponse.json({ error: "帖子不存在" }, { status: 404 });
  }
  const baseWhere = articleId ? { articleId } : { tastingNoteId };
  const visibility = commentVisibility(session?.user);
  const where = {
    ...baseWhere,
    AND: [visibility.prismaWhere],
  };

  const comments = await prisma.comment.findMany({
    where,
    select: {
      id: true,
      content: true,
      images: true,
      status: true,
      origin: true,
      createdAt: true,
      parentId: true,
      upvotes: true,
      downvotes: true,
      author: { select: { id: true, username: true, avatar: true, level: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // Attach user's vote state
  const voteMap = new Map<string, number>();
  if (session?.user?.id && comments.length > 0) {
    const votes = await prisma.vote.findMany({
      where: {
        userId: session.user.id,
        refId: { in: comments.map((c) => c.id) },
      },
      select: { refId: true, value: true },
    });
    votes.forEach((v) => voteMap.set(v.refId, v.value));
  }

  const enriched = comments.map((c) => ({
    ...c,
    initialVote: voteMap.get(c.id) || 0,
  }));

  // Viewer-keyed: `initialVote` and the caller's own pending comments differ per
  // session. Without these headers a shared cache in front of /api/* may hand one
  // visitor another visitor's pending comment or vote state.
  return NextResponse.json(enriched, {
    headers: { "Cache-Control": "private, no-store", "Vary": "Cookie" },
  });
}
