import { prisma } from "@/lib/prisma";

type NotificationType = "reply" | "upvote" | "mention" | "system" | "followed_update" | "essence";

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
