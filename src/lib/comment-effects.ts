import { prisma } from "@/lib/prisma";
import { grantExp } from "@/lib/exp";
import { notifyCommentReply } from "@/lib/notifications";

/**
 * 评论变为"已发布"时触发的副作用:文章回复数 +1、版块计数 +1、通知作者、给评论者加经验。
 *
 * 两条路径共用此函数,避免副作用逻辑漂移:
 *  ① 评论提交即通过 AI 审核(comments/route.ts)
 *  ② 待审评论被管理员通过(reviews API approve)
 */
export async function publishCommentEffects(opts: {
  commentId: string;
  authorId: string;
  articleId?: string | null;
  tastingNoteId?: string | null;
  parentId?: string | null;
}) {
  const now = new Date();
  const { commentId, authorId, articleId, parentId } = opts;

  // 仅帖子评论影响文章/版块计数与作者通知;品鉴笔记评论(tastingNoteId)走另一套,此处不涉及。
  if (articleId) {
    await prisma.article.update({
      where: { id: articleId },
      data: { replyCount: { increment: 1 }, lastRepliedAt: now },
    });

    const postArticle = await prisma.article.findUnique({
      where: { id: articleId },
      select: { boardId: true, authorId: true },
    });
    if (postArticle?.boardId) {
      await prisma.board.update({
        where: { id: postArticle.boardId },
        data: { postCount: { increment: 1 }, lastPostedAt: now },
      });
    }

    // 通知 fire-and-forget
    if (postArticle?.authorId) {
      notifyCommentReply(postArticle.authorId, authorId, articleId, parentId || undefined).catch(() => {});
    }
  }

  await grantExp(authorId, "comment", commentId);
}
