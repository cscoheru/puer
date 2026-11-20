import { Prisma } from "../generated/prisma/client.js";
import { AI_COMMENT_ORIGINS } from "./content-origin.ts";
import { can, type Actor } from "./permissions.ts";
import { REAL_AUTHOR } from "./real-author.ts";

/**
 * The sole owner of comment read visibility.
 *
 * SQL fragments use the fixed aliases `c` (comments) and `u` (users). Callers
 * cannot inject aliases, identifiers or predicates. Both adapters derive from
 * this one decision so detail GET, preview/count and parent writes cannot drift.
 */
export function commentVisibility(actor: Actor | null | undefined) {
  const moderator = can(actor, "comment:moderate");
  const userId = actor?.id ?? null;
  const origins = [...AI_COMMENT_ORIGINS];

  const statusFilter: Prisma.CommentWhereInput[] = moderator
    ? []
    : userId
      ? [{ OR: [{ status: "published" }, { status: "pending_review", authorId: userId }] }]
      : [{ status: "published" }];

  const prismaWhere: Prisma.CommentWhereInput = {
    AND: [
      { OR: [{ author: REAL_AUTHOR }, { origin: { in: origins } }] },
      ...statusFilter,
    ],
  };

  const statusSql = moderator
    ? Prisma.empty
    : userId
      ? Prisma.sql`AND (c.status = 'published' OR (c.status = 'pending_review' AND c."authorId" = ${userId}))`
      : Prisma.sql`AND c.status = 'published'`;

  // Prisma binds a JavaScript array as jsonb even before a ::text[] cast.
  // Expand values into SQL parameters instead of relying on array binding.
  const originSql = Prisma.sql`
    (u."isSynthetic" = FALSE OR c."origin" IN (${Prisma.join(origins)}))
  `;

  return {
    moderator,
    userId,
    prismaWhere,
    sql: Prisma.sql`${originSql} ${statusSql}`,
    /** Human selection is based on the author, never on an origin value. */
    humanSql: Prisma.sql`u."isSynthetic" = FALSE`,
    aiSql: Prisma.sql`c."origin" IN (${Prisma.join(origins)})`,
  };
}

export type CommentVisibility = ReturnType<typeof commentVisibility>;
