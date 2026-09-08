import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";
import { publishArticles } from "@/lib/article-publish";
import { pingSearchEngines } from "@/lib/sitemap-ping";

export async function POST(req: NextRequest) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const { articleIds, action } = await req.json();
  if (!Array.isArray(articleIds) || !action) {
    return Response.json({ error: "参数错误" }, { status: 400 });
  }

  // Content management never touches drafts — the review gate at /admin/drafts
  // owns every draft operation (edit/publish/archive/delete). Batch calls that
  // include drafts silently drop them so a mixed selection can't bypass review.
  const found = await prisma.article.findMany({
    where: { id: { in: articleIds } },
    select: { id: true, status: true },
  });
  const ids = found.filter((a) => a.status !== "draft").map((a) => a.id);
  const skippedDrafts = articleIds.length - ids.length;
  if (ids.length === 0) {
    return Response.json(
      skippedDrafts > 0
        ? { ok: true, affected: 0, skippedDrafts, note: "草稿请到「草稿审校」中操作" }
        : { ok: true, affected: 0 }
    );
  }

  switch (action) {
    case "archive":
      await prisma.article.updateMany({ where: { id: { in: ids } }, data: { status: "archived" } });
      break;
    case "publish": {
      // Unified publish: exp to authors + board counters fire exactly once per
      // article (winner semantics). De-duplication handled inside.
      const r = await publishArticles({ ids, actorId: session.user.id });
      // Only ping search engines when something actually went live.
      if (r.publishedIds.length > 0) pingSearchEngines();
      return Response.json({
        ok: true,
        published: r.publishedIds.length,
        republished: r.republishedIds.length,
        alreadyPublished: r.alreadyPublishedIds.length,
        notFound: r.rejectedIds.length,
        skippedDrafts,
      });
    }
    case "delete":
      await prisma.article.deleteMany({ where: { id: { in: ids } } });
      break;
    case "pin":
      await prisma.article.updateMany({ where: { id: { in: ids } }, data: { isPinned: true } });
      break;
    case "unpin":
      await prisma.article.updateMany({ where: { id: { in: ids } }, data: { isPinned: false } });
      break;
    case "essence":
      await prisma.article.updateMany({ where: { id: { in: ids } }, data: { isEssence: true } });
      break;
    case "unessence":
      await prisma.article.updateMany({ where: { id: { in: ids } }, data: { isEssence: false } });
      break;
    default:
      return Response.json({ error: "未知操作" }, { status: 400 });
  }

  return Response.json({ ok: true, affected: ids.length, skippedDrafts });
}
