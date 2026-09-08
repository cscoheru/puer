/**
 * Prisma `where` fragment for articles visible to a user in PUBLIC lists
 * (forum feed, latest sidebar, search, tea-related posts, sitemap, stats).
 *
 * Returns: published AND (not private, OR authored by the viewer).
 * - Anonymous viewer (no userId): all private posts hidden.
 * - Logged-in viewer: sees their own private posts among the public ones.
 *
 * Do NOT use this on a user's OWN profile page — the owner should see all
 * their posts including private; handle that case inline (isOwner → no
 * visibility filter).
 */
export function visibleArticleWhere(userId?: string | null) {
  return {
    status: "published" as const,
    OR: [
      { visibility: { not: "private" as const } },
      ...(userId ? [{ authorId: userId }] : []),
    ],
  };
}

export const VISIBILITY = {
  PUBLIC: "public",
  PRIVATE: "private",
} as const;

/**
 * Minimal slice of an Article needed to decide detail-level access. Keeps the
 * policy decoupled from the full Prisma model so it stays unit-testable.
 */
export interface ArticleDetailVisibility {
  status: string;
  visibility: string;
  authorId: string | null;
}

export interface ArticleViewer {
  userId?: string | null;
  isAdmin?: boolean;
}

/**
 * Detail-level access policy for ONE article (the API GET, the forum thread
 * page, and generateMetadata must all share it).
 *
 * Fail-closed by design: only a published+public article is open to the world.
 * Anything else requires the author or an admin, and an unrecognized status
 * is denied rather than shown. Matrix (design doc §可见性):
 *
 *   published + public       → anyone
 *   published + private      → author or admin
 *   draft / pending_review   → author or admin
 *   archived                 → admin only
 *   unknown status           → deny
 */
export function canViewArticleDetail(
  article: ArticleDetailVisibility,
  viewer: ArticleViewer,
): boolean {
  const isOwner =
    !!viewer.userId && !!article.authorId && viewer.userId === article.authorId;
  const isAdmin = !!viewer.isAdmin;

  switch (article.status) {
    case "published":
      if (article.visibility === VISIBILITY.PRIVATE) return isOwner || isAdmin;
      return true;
    case "draft":
    case "pending_review":
      return isOwner || isAdmin;
    case "archived":
      return isAdmin;
    default:
      return false;
  }
}
