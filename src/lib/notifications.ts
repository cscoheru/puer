import { prisma } from "@/lib/prisma";

/**
 * 站内通知的类型。
 *
 * DB 里 `notifications.type` 是自由字符串（VarChar(30)，没有 CHECK），
 * 所以新增类型不需要迁移 —— 但**应用层这份清单要跟着加**，否则将来
 * 有人写 `type: "reminder"` 会过不了类型检查。
 *
 * - reply：帖子/评论收到回复
 * - upvote：点赞（尚未实现，只是字面量）
 * - mention：@提及（尚未实现，只是字面量）
 * - system：系统消息（审核结果、密码重置、交易…）
 * - followed_update：关注的帖子有更新
 * - essence：帖子被设为精华
 * - reminder：**复饮提醒**（F4 · PRD v0.3 §7）—— 到期的茶仓条目
 */
export type NotificationType =
  | "reply"
  | "upvote"
  | "mention"
  | "system"
  | "followed_update"
  | "essence"
  | "reminder";

export async function createNotification(
  userId: string,
  type: NotificationType,
  content: string,
  link?: string,
) {
  await prisma.notification.create({
    data: { userId, type, content, link },
  });
}

export async function notifyCommentReply(
  articleAuthorId: string,
  commentAuthorId: string,
  articleId: string,
  parentAuthorId?: string,
) {
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { title: true },
  });
  if (!article) return;

  // Notify article author
  if (articleAuthorId !== commentAuthorId) {
    await createNotification(
      articleAuthorId,
      "reply",
      `你的帖子「${article.title.slice(0, 30)}」有新回复`,
      `/forum/thread/${articleId}`,
    );
  }

  // Notify parent comment author (if replying to a comment)
  if (parentAuthorId && parentAuthorId !== commentAuthorId && parentAuthorId !== articleAuthorId) {
    await createNotification(
      parentAuthorId,
      "reply",
      `你的评论收到回复`,
      `/forum/thread/${articleId}`,
    );
  }

  // Notify followers of this article (batch insert)
  const followers = await prisma.followedArticle.findMany({
    where: { articleId, userId: { not: commentAuthorId } },
    select: { userId: true },
  });
  const followerNotifications = followers
    .filter((f) => f.userId !== articleAuthorId)
    .map((f) => ({
      userId: f.userId,
      type: "followed_update" as const,
      content: `你关注的帖子「${article.title.slice(0, 30)}」有新回复`,
      link: `/forum/thread/${articleId}`,
    }));
  if (followerNotifications.length > 0) {
    await prisma.notification.createMany({ data: followerNotifications });
  }
}
