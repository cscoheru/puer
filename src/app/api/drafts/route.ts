import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishArticles } from "@/lib/article-publish";
import { noteIdFromDraftId } from "@/lib/tea-drafts/id";
import { sanitizeNoteHtml } from "@/lib/tea-drafts/sanitize";
import { planVideoSync, validateDraftImages } from "@/lib/tea-drafts/draft-media";
import { generateSlideshowVideo } from "@/lib/slideshow-video";

/**
 * Read-only source-note view for a tasting-note draft. Resolves only for
 * `tasting-draft_` ids (reversed to the note via the deterministic id); other
 * drafts return null. Deliberately excludes moderation/AI fields — this is the
 * original manual note, shown so the reviewer can confirm the draft is a
 * faithful, un-rewritten projection of it.
 */
async function resolveSourceNote(draftId: string) {
  const noteId = noteIdFromDraftId(draftId);
  if (!noteId) return null;
  const note = await prisma.tastingNote.findUnique({
    where: { id: noteId },
    select: {
      id: true,
      title: true,
      content: true,
      summary: true,
      source: true,
      brewMethod: true,
      waterTemp: true,
      teaWeight: true,
      steepCount: true,
      images: true,
      videoUrl: true,
      createdAt: true,
      tea: { select: { name: true, brand: true, year: true, type: true } },
      author: { select: { id: true, username: true } },
    },
  });
  if (!note) return null;
  // Trust boundary: the note `content` is untrusted author HTML. Sanitize it
  // here so the client can render it via dangerouslySetInnerHTML safely.
  return { ...note, content: sanitizeNoteHtml(note.content) };
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "admin") {
    return NextResponse.json({ error: "仅管理员" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);

  // Single-draft review view: full draft + read-only sourceNote (tasting drafts
  // only). Used by the admin review panel; never mixed with Article.moderation.
  const singleId = searchParams.get("id");
  if (singleId) {
    const draft = await prisma.article.findUnique({
      where: { id: singleId },
      include: {
        tea: { select: { name: true, brand: true, year: true, type: true } },
        author: { select: { id: true, username: true } },
        board: { select: { id: true, name: true, slug: true } },
      },
    });
    if (!draft || draft.status !== "draft") {
      return NextResponse.json({ error: "草稿不存在" }, { status: 404 });
    }
    const sourceNote = await resolveSourceNote(draft.id);
    return NextResponse.json({ draft, sourceNote });
  }

  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "30");

  const [drafts, total] = await Promise.all([
    prisma.article.findMany({
      where: { status: "draft" },
      orderBy: { createdAt: "desc" },
      include: {
        tea: { select: { name: true, brand: true, year: true } },
        author: { select: { id: true, username: true } },
      },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.article.count({ where: { status: "draft" } }),
  ]);

  return NextResponse.json({ drafts, total, page, limit });
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "admin") {
    return NextResponse.json({ error: "仅管理员" }, { status: 403 });
  }

  const { id, title, content, tags, status, images } = await req.json();
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });

  // Editable fields. The publish transition is owned by publishArticles so the
  // author's exp and board counters fire exactly once on draft→published; apply
  // a status change directly only for non-publish targets (e.g. "archived").
  const wantsPublish = status === "published";
  const data: Record<string, unknown> = {};
  if (title !== undefined) data.title = title;
  if (content !== undefined) data.content = content;
  if (tags !== undefined) data.tags = tags;
  if (!wantsPublish && status !== undefined) data.status = status;

  // Image edit (admin): validated against the media allowlist, then keep the
  // slideshow video consistent with the new set (see draft-media.ts).
  let videoPlan: "keep" | "regenerate" | "clear" = "keep";
  if (images !== undefined) {
    const v = validateDraftImages(images);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    const current = await prisma.article.findUnique({
      where: { id },
      select: { images: true },
    });
    if (!current) return NextResponse.json({ error: "草稿不存在" }, { status: 404 });
    videoPlan = planVideoSync(current.images ?? [], v.images);
    data.images = v.images;
    if (videoPlan === "clear") data.videoUrl = null;
  }

  const article = await prisma.article.update({ where: { id }, data });

  // Regeneration runs after the images persist, mirroring the runner's
  // attachVideos ordering. generateSlideshowVideo never throws; on failure the
  // draft keeps its previous video and the response says so.
  let videoRegenerated = false;
  let videoRegenFailed = false;
  if (videoPlan === "regenerate") {
    const v = await generateSlideshowVideo((data.images as string[]) ?? []);
    if (v) {
      await prisma.article.update({ where: { id }, data: { videoUrl: v.videoUrl } });
      videoRegenerated = true;
    } else {
      videoRegenFailed = true;
    }
  }

  if (wantsPublish) {
    await publishArticles({ ids: [id], actorId: session.user.id });
    const fresh = await prisma.article.findUnique({ where: { id } });
    return NextResponse.json(fresh ?? article);
  }
  const finalArticle = videoRegenerated
    ? await prisma.article.findUnique({ where: { id } })
    : article;
  return NextResponse.json({
    ...(finalArticle ?? article),
    ...(videoRegenFailed ? { videoRegenFailed: true } : {}),
  });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user || (session.user as any).role !== "admin") {
    return NextResponse.json({ error: "仅管理员" }, { status: 403 });
  }

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });

  await prisma.article.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
