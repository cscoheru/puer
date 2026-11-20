import { randomUUID } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "./prisma.ts";
import { commentVisibility } from "./comment-visibility.ts";
import { prismaErrorSignals } from "./comment-feed-errors.ts";
import {
  FEED_COMMENT_LIMITS,
  type FeedCommentPreviewItem,
} from "./feed-comment-contract.ts";
import type { Actor } from "./permissions.ts";

export interface CandidateRow {
  id: string;
  articleId: string;
  parentId: string | null;
  content: string;
  contentTruncated: boolean;
  status: string;
  origin: string | null;
  createdAt: Date;
  kind: number;
  authorId: string;
  username: string;
  avatar: string | null;
  level: number;
}

interface CountRow {
  articleId: string;
  n: bigint;
}

export interface FeedCommentBatch {
  previews: Map<string, FeedCommentPreviewItem[]> | null;
  counts: Map<string, number> | null;
}

interface BatchReads {
  previews: () => Promise<Map<string, FeedCommentPreviewItem[]>>;
  counts: () => Promise<Map<string, number>>;
}

function compareNewest(a: CandidateRow, b: CandidateRow): number {
  const time = b.createdAt.getTime() - a.createdAt.getTime();
  return time || b.id.localeCompare(a.id);
}

function toPreviewItem(row: CandidateRow): FeedCommentPreviewItem {
  return {
    id: row.id,
    articleId: row.articleId,
    parentId: row.parentId,
    content: row.content,
    contentTruncated: row.contentTruncated,
    status: row.status,
    origin: row.origin,
    createdAt: row.createdAt.toISOString(),
    author: {
      id: row.authorId,
      username: row.username,
      avatar: row.avatar,
      level: row.level,
    },
  };
}

/** Apply human-first selection after the SQL candidate cap, then display oldest-first. */
export function selectFeedCommentPreviews(
  articleIds: readonly string[],
  candidates: readonly CandidateRow[],
): Map<string, FeedCommentPreviewItem[]> {
  const byArticle = new Map<string, CandidateRow[]>();
  for (const row of candidates) {
    const list = byArticle.get(row.articleId) ?? [];
    list.push(row);
    byArticle.set(row.articleId, list);
  }

  return new Map(articleIds.map((articleId) => {
    const rows = (byArticle.get(articleId) ?? []).sort(compareNewest);
    const humans = rows.filter((row) => row.kind === 0)
      .slice(0, FEED_COMMENT_LIMITS.humanPreview);
    const selected = humans.length > 0
      ? humans
      : rows.filter((row) => row.kind === 1).slice(0, FEED_COMMENT_LIMITS.aiFallback);
    selected.sort((a, b) => -compareNewest(a, b));
    return [articleId, selected.map(toPreviewItem)];
  }));
}

/** Actual candidate SQL, also consumed by the read-only performance harness. */
export function feedCommentCandidatesSql(
  articleIds: readonly string[],
  actor: Actor | null | undefined,
): Prisma.Sql {
  const visibility = commentVisibility(actor);
  const ids = [...articleIds];
  return Prisma.sql`
      WITH page(id) AS (
        VALUES ${Prisma.join(ids.map((articleId) => Prisma.sql`(${articleId})`))}
      )
      SELECT candidate.*
      FROM page p
      CROSS JOIN LATERAL (
        (
          SELECT c.id, c."articleId", c."parentId",
                 left(c.content, ${FEED_COMMENT_LIMITS.previewCodePoints}::int) AS content,
                 (length(c.content) > ${FEED_COMMENT_LIMITS.previewCodePoints}) AS "contentTruncated",
                 c.status, c.origin, c."createdAt", 0 AS kind,
                 u.id AS "authorId", u.username, u.avatar, u.level
          FROM comments c
          JOIN users u ON u.id = c."authorId"
          WHERE c."articleId" = p.id AND c."parentId" IS NULL
            AND ${visibility.sql} AND ${visibility.humanSql}
          ORDER BY c."createdAt" DESC, c.id DESC
          LIMIT ${FEED_COMMENT_LIMITS.humanPreview}
        )
        UNION ALL
        (
          SELECT c.id, c."articleId", c."parentId",
                 left(c.content, ${FEED_COMMENT_LIMITS.previewCodePoints}::int) AS content,
                 (length(c.content) > ${FEED_COMMENT_LIMITS.previewCodePoints}) AS "contentTruncated",
                 c.status, c.origin, c."createdAt", 1 AS kind,
                 u.id AS "authorId", u.username, u.avatar, u.level
          FROM comments c
          JOIN users u ON u.id = c."authorId"
          WHERE c."articleId" = p.id AND c."parentId" IS NULL
            AND ${visibility.sql} AND ${visibility.aiSql}
          ORDER BY c."createdAt" DESC, c.id DESC
          LIMIT ${FEED_COMMENT_LIMITS.aiFallback}
        )
      ) candidate
    `;
}

export async function readFeedCommentCandidates(
  articleIds: readonly string[],
  actor: Actor | null | undefined,
): Promise<CandidateRow[]> {
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', ${`${FEED_COMMENT_LIMITS.statementTimeoutMs}ms`}, true)
    `;
    return tx.$queryRaw<CandidateRow[]>(feedCommentCandidatesSql(articleIds, actor));
  }, { timeout: FEED_COMMENT_LIMITS.transactionTimeoutMs });
  return rows;
}

export async function readPreviewCandidates(
  articleIds: readonly string[],
  actor: Actor | null | undefined,
): Promise<Map<string, FeedCommentPreviewItem[]>> {
  const rows = await readFeedCommentCandidates(articleIds, actor);
  return selectFeedCommentPreviews(articleIds, rows);
}

/** Actual grouped-count SQL, shared with the read-only performance harness. */
export function feedVisibleCountsSql(
  articleIds: readonly string[],
  actor: Actor | null | undefined,
): Prisma.Sql {
  const visibility = commentVisibility(actor);
  return Prisma.sql`
      SELECT c."articleId", count(*)::bigint AS n
      FROM comments c
      JOIN users u ON u.id = c."authorId"
      WHERE c."articleId" IN (${Prisma.join([...articleIds])}) AND ${visibility.sql}
      GROUP BY c."articleId"
    `;
}

export async function readVisibleCounts(
  articleIds: readonly string[],
  actor: Actor | null | undefined,
): Promise<Map<string, number>> {
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', ${`${FEED_COMMENT_LIMITS.statementTimeoutMs}ms`}, true)
    `;
    return tx.$queryRaw<CountRow[]>(feedVisibleCountsSql(articleIds, actor));
  }, { timeout: FEED_COMMENT_LIMITS.transactionTimeoutMs });
  return new Map(rows.map((row) => [row.articleId, Number(row.n)]));
}

export function feedCommentErrorCategory(error: unknown): string {
  // Same signal shape as the write side: a Prisma-wrapped raw query hides the
  // SQLSTATE under meta.code, so reading only the top-level code would classify
  // a real statement timeout as a generic database error. Message matching stays
  // as a fallback for drivers that only surface the text.
  const { code, metaCode, message } = prismaErrorSignals(error);
  if (code === "57014" || metaCode === "57014" || /statement timeout/i.test(message)) {
    return "statement_timeout";
  }
  if (code === "P2028" || metaCode === "P2028" ||
      (/transaction/i.test(message) && /timeout|expired/i.test(message))) {
    return "transaction_timeout";
  }
  if (/connection|connect|database.*reachable/i.test(message)) return "database_unavailable";
  return "database_error";
}

function logReadFailure(
  commentLoadId: string,
  operation: "preview" | "count",
  articleCount: number,
  error: unknown,
): void {
  console.error("[feed-comments]", JSON.stringify({
    commentLoadId,
    operation,
    articleCount,
    category: feedCommentErrorCategory(error),
  }));
}

/** Two independent data reads per non-empty page. There is no viewer-keyed cache. */
export async function loadFeedCommentBatch(
  articleIds: readonly string[],
  actor: Actor | null | undefined,
  commentLoadId: string = randomUUID(),
  reads?: BatchReads,
): Promise<FeedCommentBatch> {
  if (articleIds.length === 0) {
    return { previews: new Map(), counts: new Map() };
  }
  const tasks: BatchReads = reads ?? {
    previews: () => readPreviewCandidates(articleIds, actor),
    counts: () => readVisibleCounts(articleIds, actor),
  };
  const [previewResult, countResult] = await Promise.allSettled([
    tasks.previews(),
    tasks.counts(),
  ]);
  if (previewResult.status === "rejected") {
    logReadFailure(commentLoadId, "preview", articleIds.length, previewResult.reason);
  }
  if (countResult.status === "rejected") {
    logReadFailure(commentLoadId, "count", articleIds.length, countResult.reason);
  }
  return {
    previews: previewResult.status === "fulfilled" ? previewResult.value : null,
    counts: countResult.status === "fulfilled" ? countResult.value : null,
  };
}
