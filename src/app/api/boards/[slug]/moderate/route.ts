import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const board = await prisma.board.findUnique({ where: { slug } });
  if (!board) return NextResponse.json({ error: "版块不存在" }, { status: 404 });

  const moderator = await prisma.boardModerator.findUnique({
    where: { boardId_userId: { boardId: board.id, userId: session.user.id } },
  });
  const isAdmin = session.user.role === "admin";

  if (!isAdmin && (!moderator || moderator.status !== "approved")) {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  const isDeputy = moderator?.role === "deputy";
  const isModerator = moderator?.role === "moderator" || isAdmin;

  const body = await req.json();
  const { articleId, action } = body; // action: pin | unpin | essence | unessence | delete

  if (!articleId || !action) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const article = await prisma.article.findUnique({ where: { id: articleId } });
  if (!article || article.boardId !== board.id) {
    return NextResponse.json({ error: "帖子不存在" }, { status: 404 });
  }

  switch (action) {
    case "pin":
    case "unpin":
    case "essence":
    case "unessence":
      // Both moderator and deputy can do these
      const pinData = action === "pin" ? { isPinned: true } : action === "unpin" ? { isPinned: false } : {};
      const essenceData = action === "essence" ? { isEssence: true } : action === "unessence" ? { isEssence: false } : {};
      await prisma.article.update({ where: { id: articleId }, data: { ...pinData, ...essenceData } });
      break;

    case "delete":
      if (isModerator) {
        // Moderator/admin can delete directly
        await prisma.article.update({ where: { id: articleId }, data: { status: "archived" } });
      } else if (isDeputy) {
        // Deputy: create approval request instead
        const existing = await prisma.moderateAction.findFirst({
          where: { articleId, boardId: board.id, status: "pending" },
        });
        if (existing) {
          return NextResponse.json({ error: "已有待审核的删除请求" }, { status: 400 });
        }
        await prisma.moderateAction.create({
          data: {
            boardId: board.id,
            articleId,
            requestedBy: session.user.id,
            reason: body.reason || null,
          },
        });
        return NextResponse.json({ success: true, pending: true,
          message: "删除请求已提交，等待版主审批" });
      }
      break;

    default:
      return NextResponse.json({ error: "不支持的操作" }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}
