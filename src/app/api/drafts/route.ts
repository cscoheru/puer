import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishArticles } from "@/lib/article-publish";
import { noteIdFromDraftId } from "@/lib/tea-drafts/id";
import { sanitizeNoteHtml } from "@/lib/tea-drafts/sanitize";
import { planVideoSync, validateDraftImages } from "@/lib/tea-drafts/draft-media";
import { generateSlideshowVideo } from "@/lib/slideshow-video";
import { deepSeekAdapt, toAdaptSource } from "@/lib/tea-drafts/adapt";
import { normalizeTastingNote } from "@/lib/tea-drafts/normalize";
import { buildAiOriginal, type AiOriginal } from "@/lib/tea-drafts/runner";
import { styleFor } from "@/lib/tea-drafts/styles";

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

/**
 * Has a human touched this draft since the last AI output?
 *
 * `Article.aiOriginal` is the frozen AI original; `prisma/schema.prisma` defines
 * `diff(aiOriginal, 现值)` as the pure human-edit signal. So a divergence here IS
 * a human edit — a much sharper test than "was anything ever saved", which also
 * counts the rewrite itself and would make the button one-shot.
 *
 * Rows with no usable provenance fall back to the runner's `applyAdapt` rule
 * (`updatedAt === createdAt`): untouched since creation.
 */
function humanEdited(article: {
  title: string;
  content: string;
  summary: string | null;
  createdAt: Date;
  updatedAt: Date;
  aiOriginal: unknown;
}): boolean {
  const ai = article.aiOriginal as Partial<AiOriginal> | null;
  if (ai && typeof ai === "object" && typeof ai.content === "string") {
    return (
      article.content !== ai.content ||
      (article.summary ?? null) !== (ai.summary ?? null) ||
      (typeof ai.title === "string" && article.title !== ai.title)
    );
  }
  return article.updatedAt.getTime() !== article.createdAt.getTime();
}

/**
 * `action: "rewrite"` — grounded AI re-creation of a tasting draft's body.
 *
 * Deliberately mirrors `applyAdapt`: the creative style is re-derived from the
 * note id (deterministic rotation → nothing to persist), the model call fails
 * closed (never throws; the verbatim draft is kept and flagged), and the write
 * is conditional so a human who saves concurrently wins. The difference is the
 * precondition — `humanEdited` above, not `updatedAt === createdAt` — so a
 * reviewer can re-roll the rewrite until they edit it themselves.
 */
async function rewriteDraft(id: string) {
  const pre = await prisma.article.findUnique({ where: { id } });
  if (!pre) return NextResponse.json({ error: "草稿不存在" }, { status: 404 });
  if (pre.status !== "draft") {
    return NextResponse.json({ error: "仅草稿可重写" }, { status: 400 });
  }
  const noteId = noteIdFromDraftId(pre.id);
  if (!noteId) {
    return NextResponse.json({ error: "非茶记草稿，无来源笔记" }, { status: 400 });
  }
  if (humanEdited(pre)) {
    return NextResponse.json({
      skipped: true,
      reason: "该草稿已有人工修改，为保留你的版本已放弃重写",
    });
  }

  const note = await prisma.tastingNote.findUnique({
    where: { id: noteId },
    select: {
      id: true,
      title: true,
      content: true,
      summary: true,
      teaId: true,
      authorId: true,
      source: true,
      brewMethod: true,
      waterTemp: true,
      teaWeight: true,
      steepCount: true,
      images: true,
      videoUrl: true,
      createdAt: true,
    },
  });
  if (!note) {
    return NextResponse.json({ error: "来源笔记不存在" }, { status: 404 });
  }

  // The tea product name feeds the adapter, not the row: the rewrite writes
  // only content/summary/aiOriginal and deliberately never touches the title.
  // But `toAdaptSource` needs the name so the model composes under the article's
  // real title and the name is licensed as a source fact (product names carry
  // digits — see the grounding note there).
  const tea = note.teaId
    ? await prisma.tea.findUnique({ where: { id: note.teaId }, select: { name: true } })
    : null;
  const source = toAdaptSource(normalizeTastingNote({ ...note, teaName: tea?.name ?? null }));
  // `styleFor` returns the whole record; the model call and the provenance
  // stamp both want the key. Same `.key` discipline as the runner's creation
  // path, so the two cannot drift apart in what they record.
  const style = styleFor(noteId).key;

  const r = await deepSeekAdapt({ source, style });
  if (!r.ok) {
    // Fail closed: keep the verbatim draft. The caller still shows 「待重写」
    // and can press the button again — nothing is half-written.
    return NextResponse.json({ adapted: false, reason: r.reason });
  }

  // Optimistic-concurrency write: only land if nothing moved while the model
  // was thinking. count = 0 → a human saved in the meantime, keep their version.
  const { count } = await prisma.article.updateMany({
    where: { id: pre.id, updatedAt: pre.updatedAt, status: "draft" },
    data: {
      content: r.content,
      summary: r.summary,
      aiOriginal: buildAiOriginal({
        title: pre.title,
        content: r.content,
        summary: r.summary,
        style: r.style,
        adapted: true,
      }),
    },
  });
  if (count !== 1) {
    return NextResponse.json({
      skipped: true,
      reason: "重写期间草稿被人工保存，已保留你的版本",
    });
  }

  const fresh = await prisma.article.findUnique({ where: { id: pre.id } });
  return NextResponse.json({
    ...fresh,
    adapted: true,
    aiOriginal: fresh?.aiOriginal ?? null,
  });
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

  const { id, action, title, content, tags, status, images } = await req.json();
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });

  // Rewrite is its own action: it owns the whole body rewrite and writes only
  // content/summary/aiOriginal. Mixing it with the field-edit path below would
  // make it possible to "rewrite" and edit in one request and lose the
  // human-edit precondition that keeps the reviewer's version safe.
  if (action === "rewrite") return rewriteDraft(id);

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
