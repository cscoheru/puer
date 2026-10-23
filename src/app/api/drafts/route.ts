import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { publishArticles } from "@/lib/article-publish";
import { removeTastingNotesForArticles } from "@/lib/tasting-note-sync";
import { noteIdFromDraftId } from "@/lib/tea-drafts/id";
import { sanitizeNoteHtml } from "@/lib/tea-drafts/sanitize";
import { planVideoSync, validateDraftImages } from "@/lib/tea-drafts/draft-media";
import { generateSlideshowVideo } from "@/lib/slideshow-video";
import { deepSeekAdapt, toAdaptSource } from "@/lib/tea-drafts/adapt";
import { normalizeTastingNote } from "@/lib/tea-drafts/normalize";
import { buildAiOriginal, type AiOriginal } from "@/lib/tea-drafts/runner";
import { styleFor } from "@/lib/tea-drafts/styles";
import {
  normalizeFeedbackReason,
  parseFeedbackCategory,
  type FeedbackCategory,
} from "@/lib/news-draft/feedback-policy";
import { can } from "@/lib/permissions";

/**
 * 允许**直接**写入的状态（不经过专门 action）。
 *
 * 只有 `archived`（归档）：草稿箱里的「归档」是纯状态切换，没有副作用。
 * `rejected` 不在其中——退回必须连带写 reviewFeedback，走 `action: "reject"`。
 */
const DIRECT_STATUS_ALLOWED = new Set(["archived"]);

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

/**
 * `action: "reject"` — 退回草稿并记录选题质量反馈。
 *
 * 退回**不是删除**：行保留、状态改为 `rejected`，从待审队列移出。
 * 保留的理由是**幂等墓碑**——资讯稿主键是 `news-draft_<hash(sourceKey)>`，
 * 同一份素材永远生成同一个 id；行在，脚本下次跑到它就会按「已存在」跳过，
 * 所以被退回的素材**永久不会再成稿**。删掉行反而会让它复活。
 *
 * 反馈写 `reviewFeedback`（不是 `moderation`——后者是机器内容安全判定，
 * 语义不同，混用会污染审校统计）。
 */
async function rejectDraft(
  id: string,
  actorId: string,
  body: { category?: unknown; reason?: unknown },
) {
  const category = parseFeedbackCategory(body.category);
  if (!category) {
    return NextResponse.json({ error: "退回分类不合法" }, { status: 400 });
  }
  const reason = normalizeFeedbackReason(body.reason);
  if (!reason) {
    return NextResponse.json(
      { error: "退回必须说明原因（4–500 字）" },
      { status: 400 },
    );
  }

  const pre = await prisma.article.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!pre) return NextResponse.json({ error: "草稿不存在" }, { status: 404 });
  // 幂等：已退回的直接返回成功，但**明确标记 skipped**——否则第二个管理员的
  // 反馈会被静默丢弃，而客户端把 2xx 当成功，他以为自己记下了。
  // （rewrite 路径用的是同一个 skipped 形状。）
  if (pre.status === "rejected") {
    const fresh = await prisma.article.findUnique({ where: { id } });
    return NextResponse.json({
      ...(fresh ?? {}),
      skipped: true,
      reason: "该稿已退回，未重复记录反馈",
    });
  }
  if (pre.status !== "draft") {
    return NextResponse.json({ error: "仅草稿可退回" }, { status: 400 });
  }

  const feedback = {
    category,
    reason,
    by: actorId,
    at: new Date().toISOString(),
  } satisfies { category: FeedbackCategory; reason: string; by: string; at: string };

  // 原子状态迁移：WHERE 里带上 status="draft"，并发场景下不会与「发布/归档」
  // 交错出「已发布却被标成已退回」的错位（先查后改的 TOCTOU）。
  // count===0 说明状态已被别人改掉（发布/归档/另一次退回），此时不覆盖。
  const { count } = await prisma.article.updateMany({
    where: { id, status: "draft" },
    data: { status: "rejected", reviewFeedback: feedback },
  });
  if (count !== 1) {
    // 400 而非 409：本仓库对「状态不允许」一律用 400（见 admin/reviews/[id]）。
    return NextResponse.json(
      { error: "草稿状态已变化（可能已发布或归档），未退回" },
      { status: 400 },
    );
  }
  const updated = await prisma.article.findUnique({ where: { id } });
  return NextResponse.json(updated);
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || !can(session.user, "admin:content")) {
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

  // 已退回列表：反馈闭环的可观测面。管理员要能看到「我退回了什么、为什么」，
  // 否则退回就只是个黑洞动作；下游脚本也靠这些 reviewFeedback 推导选题规则。
  //
  // 响应信封与普通列表**完全一致**（drafts/total/page/limit）——同一个 `drafts`
  // 键返回两种形状会让客户端读 total 时拿到 undefined，分页参数也会失效。
  if (searchParams.get("rejected") === "1") {
    const where = { status: "rejected" };
    const [rejected, rejectedTotal] = await Promise.all([
      prisma.article.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          title: true,
          status: true,
          reviewFeedback: true,
          updatedAt: true,
          author: { select: { username: true } },
        },
      }),
      prisma.article.count({ where }),
    ]);
    return NextResponse.json({ drafts: rejected, total: rejectedTotal, page, limit });
  }

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

/**
 * `PUT /api/drafts` — 草稿字段编辑与状态迁移（仅管理员）。
 *
 * 请求体契约：
 * ```
 * {
 *   id: string,                    // 必填
 *   action?: "rewrite" | "reject", // 动作分支，互斥于下面的字段编辑
 *   title?: string, content?: string, tags?: string[], images?: string[],
 *   status?: "published" | "archived",
 * }
 * ```
 * - `action: "rewrite"`：品鉴草稿的 AI 重写（只改 content/summary/aiOriginal）。
 * - `action: "reject"`：退回资讯草稿并记录选题反馈，必须带
 *   `category`（五选一）与 `reason`（4–500 字），并把状态改为 `rejected`。
 * - 不带 action 时：字段编辑 + 可选状态变更。**直接写 status 只允许
 *   `archived`**；`published` 走 publishArticles（要发经验、算版块计数），
 *   `rejected` 必须走 `action: "reject"`（要连带写 reviewFeedback）。
 */
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user || !can(session.user, "admin:content")) {
    return NextResponse.json({ error: "仅管理员" }, { status: 403 });
  }

  const { id, action, title, content, tags, status, images, category, reason } =
    await req.json();
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });

  // Rewrite is its own action: it owns the whole body rewrite and writes only
  // content/summary/aiOriginal. Mixing it with the field-edit path below would
  // make it possible to "rewrite" and edit in one request and lose the
  // human-edit precondition that keeps the reviewer's version safe.
  if (action === "rewrite") return rewriteDraft(id);

  // Reject is its own action for the same reason: it owns the status transition
  // (draft → rejected) and the reviewFeedback write, which must not be
  // separable from the transition.
  if (action === "reject") {
    return rejectDraft(id, session.user.id, { category, reason });
  }

  // Editable fields. The publish transition is owned by publishArticles so the
  // author's exp and board counters fire exactly once on draft→published; apply
  // a status change directly only for non-publish targets (e.g. "archived").
  const wantsPublish = status === "published";
  const data: Record<string, unknown> = {};
  if (title !== undefined) data.title = title;
  if (content !== undefined) data.content = content;
  if (tags !== undefined) data.tags = tags;
  if (!wantsPublish && status !== undefined) {
    // 白名单：直接写 status 只允许归档。`rejected` 必须走 `action: "reject"`
    // ——它要连带写 reviewFeedback，绕过它就等于塞一条没有反馈的退回记录，
    // 污染下游的选题规则推导。其他未知状态一律拒绝。
    if (!DIRECT_STATUS_ALLOWED.has(status)) {
      // 不回显原始入参（可能是任意长度的客户端字符串）。
      return NextResponse.json(
        { error: "不支持的状态变更（仅支持 archived）" },
        { status: 400 },
      );
    }
    data.status = status;
  }

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
  if (!session?.user || !can(session.user, "admin:content")) {
    return NextResponse.json({ error: "仅管理员" }, { status: 403 });
  }

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });

  await removeTastingNotesForArticles([id]);
  await prisma.article.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
