/**
 * Tea-draft runner — the DB-coupled orchestration that turns the configured
 * author's manual tasting notes into exactly zero or one reviewable draft per
 * run, inside a single advisory-locked transaction.
 *
 * Two exports, two test surfaces:
 *   - `selectDrafts(...)` — PURE composition (gates → score → threshold → rank
 *     → cap → assemble). No DB, no `@/` runtime imports, duck-typed everywhere.
 *     Unit-tested under `node --test` (see runner.test.ts). It never invents
 *     text: every selected draft is assembled verbatim from its note by
 *     `assemble.ts`.
 *   - `runTeaDraftRunner(...)` — the transaction. Takes an INJECTED Prisma
 *     client (so the integration test can point at an isolated `_test` DB
 *     instead of the production singleton). Holds one connection, takes a
 *     transaction-scoped advisory lock, enforces the "no draft while an
 *     unreviewed one exists" + natural-day cap flood controls, fetches a bounded
 *     candidate set, delegates selection to `selectDrafts`, and writes at most
 *     `limit` drafts. A repeat run for the same note hits the deterministic PK
 *     (P2002) and is treated as "already created" — idempotent, never a second
 *     draft. DB integration-tested via tsx (see runner.integration.test.ts).
 *
 * Design constraints (v1, from the approved plan): no schema change, no model
 * call, deterministic `tasting-draft_${noteId}` id, reuses `Article.status=draft`
 * + Phase A's `publishArticles` for release, never writes `Article.tastingScores`.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { normalizeTastingNote, type NormalizedNote, type TastingNoteLike } from "./normalize.ts";
import {
  checkHardGates,
  type HardGateConfig,
  type HardGateContext,
  type HardGateRejectionReason,
} from "./hard-gates.ts";
import {
  scoreCandidate,
  rankCandidates,
  SCORE_THRESHOLD,
  type ScoringContext,
} from "./scoring.ts";
import { assembleDraft, isAllowedMediaUrl, type AssembleConfig, type AssembledDraft } from "./assemble.ts";
import { generateSlideshowVideo } from "../slideshow-video.ts";
import { tastingDraftId, noteIdFromDraftId } from "./id.ts";
import { toAdaptSource, type AdaptSource, type AdaptResult } from "./adapt.ts";

/** Prisma's P2002 (unique violation) error code — checked by duck-typing to
 *  keep this module free of any `@/` runtime import (pure-loadable). */
const PRISMA_UNIQUE_VIOLATION = "P2002";

/** Asia/Shanghai is UTC+8 with no DST — a fixed offset, so the day boundary is
 *  computed arithmetically instead of depending on a TZ database. */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Default cap on how many candidate notes to read before scoring. Bounds the
 *  query; sized to cover the full evernote corpus in wildcard mode. */
const DEFAULT_CANDIDATE_FETCH_LIMIT = 1500;

/** Prefix that marks an Article as an auto-generated tasting draft. Used for
 *  the unreviewed-count and daily-cap queries (prefix scan on the PK index). */
export const TASTING_DRAFT_PREFIX = "tasting-draft_";

/** Resolved operator configuration for a run (env-parsed by the CLI caller). */
export interface RunnerConfig extends HardGateConfig, AssembleConfig {
  /** Max drafts to create in a single run (AUTO_DRAFT_LIMIT, default 1). */
  limit: number;
  /** Max auto-drafts permitted per Asia/Shanghai natural day (default 1). */
  dailyCap: number;
  /** Max unreviewed (status=draft) auto-drafts that may accumulate before the
   *  runner stops creating new ones (AUTO_DRAFT_MAX_UNREVIEWED, default 10). */
  maxUnreviewed: number;
  /** Max candidate notes to read from the DB (default 1500). */
  candidateFetchLimit: number;
}

/** DB-dependent facts about each candidate, pre-fetched inside the tx. */
export interface CandidateFacts {
  authorActive: boolean;
  existingDraftExists: boolean;
  /** True if a tasting-draft Article already exists for this note's tea. */
  teaAlreadyCovered: boolean;
}

export interface RejectedCandidate {
  id: string;
  reason: HardGateRejectionReason | "below_score_threshold" | "rank_cap";
}

/** Output of the pure selection step. */
export interface SelectionResult {
  selected: AssembledDraft[];
  rejected: RejectedCandidate[];
}

/** Count URL-validated images + resolve a validated videoUrl for scoring. The
 *  runner (and only the runner) pre-validates media; `assemble.ts` re-validates
 *  on copy-through, so a bad URL can never reach a draft either way. */
function validatedMedia(note: NormalizedNote): {
  imageCount: number;
  videoUrl: string | null;
} {
  const imgs = Array.isArray(note.images) ? note.images.filter(isAllowedMediaUrl) : [];
  const videoUrl = note.videoUrl && isAllowedMediaUrl(note.videoUrl) ? note.videoUrl : null;
  return { imageCount: imgs.length, videoUrl };
}

/**
 * PURE selection: given already-fetched candidate notes, their DB facts, the
 * scoring context, and the operator config, decide which (if any) become drafts.
 *
 * Order is fixed and fail-closed: every candidate runs through `hard-gates`
 * first; only notes that pass AND clear `SCORE_THRESHOLD` are ranked; the top
 * `limit` are assembled into drafts. Anything else carries a structured
 * rejection reason (gate failure / below threshold / lost the rank tie-break).
 *
 * No DB, no network, no model, no `@/` runtime import — safe under `node --test`.
 */
export function selectDrafts(input: {
  candidates: readonly NormalizedNote[];
  factsByNote: ReadonlyMap<string, CandidateFacts>;
  scoringCtx: ScoringContext;
  config: RunnerConfig;
}): SelectionResult {
  const { candidates, factsByNote, scoringCtx, config } = input;
  const rejected: RejectedCandidate[] = [];
  const passing: { id: string; score: number; createdAt: number; note: NormalizedNote }[] = [];

  for (const note of candidates) {
    // Fail-closed: a note with no prefetched facts is treated as an inactive
    // author with an existing draft for an already-covered tea — i.e. must not
    // be selected.
    const facts = factsByNote.get(note.id) ?? {
      authorActive: false,
      existingDraftExists: true,
      teaAlreadyCovered: true,
    };
    const ctx: HardGateContext = {
      authorActive: facts.authorActive,
      existingDraftExists: facts.existingDraftExists,
      teaAlreadyCovered: facts.teaAlreadyCovered,
    };
    const gate = checkHardGates(
      { id: note.id, authorId: note.authorId, source: note.source, title: note.title, content: note.content, teaId: note.teaId ?? null },
      { authorId: config.authorId, noteIds: config.noteIds },
      ctx,
    );
    if (!gate.pass) {
      rejected.push({ id: note.id, reason: gate.reason as HardGateRejectionReason });
      continue;
    }

    const media = validatedMedia(note);
    const scored = scoreCandidate(
      {
        id: note.id,
        createdAt: note.createdAt,
        content: note.content,
        teaId: note.teaId,
        brewParams: {
          brewMethod: note.brewMethod,
          waterTemp: note.waterTemp,
          teaWeight: note.teaWeight,
          steepCount: note.steepCount,
        },
        imageCount: media.imageCount,
        videoUrl: media.videoUrl,
      },
      scoringCtx,
    );
    if (scored.score < SCORE_THRESHOLD) {
      rejected.push({ id: note.id, reason: "below_score_threshold" });
      continue;
    }
    passing.push({ id: scored.id, score: scored.score, createdAt: scored.createdAt, note });
  }

  // Stable rank: score DESC, createdAt DESC, id ASC (see scoring.rankCandidates).
  const ranked = rankCandidates(passing).map((r) => passing.find((p) => p.id === r.id)!);
  const chosen = ranked.slice(0, Math.max(0, config.limit));
  const chosenIds = new Set(chosen.map((c) => c.id));

  for (const p of passing) {
    if (!chosenIds.has(p.id)) rejected.push({ id: p.id, reason: "rank_cap" });
  }

  const selected = chosen.map((c) =>
    assembleDraft({ note: c.note, config: { boardId: config.boardId } }),
  );
  return { selected, rejected };
}

/** UTC instant of 00:00 Asia/Shanghai for the day containing `now`. DB stores
 *  `createdAt` in UTC, so this is the correct lower bound for "created today
 *  (Shanghai day)". `now` is injectable for deterministic tests. */
export function startOfShanghaiDayUtc(now: Date): Date {
  const shanghaiMs = now.getTime() + SHANGHAI_OFFSET_MS;
  const dayStartShanghai = Math.floor(shanghaiMs / MS_PER_DAY) * MS_PER_DAY;
  return new Date(dayStartShanghai - SHANGHAI_OFFSET_MS);
}

export type RunnerStatus =
  | "ok"
  | "skipped-already-running"
  | "skipped-unreviewed-exists"
  | "skipped-daily-cap"
  | "no-candidates";

/** Outcome of a single post-commit adapt attempt (Phase D). `updated=false`
 *  with `ok=true` means the draft was human-edited/changed before the adapt
 *  could apply — the human result is kept. */
export interface AdaptOutcome {
  id: string;
  ok: boolean;
  updated: boolean;
  reason?: string;
}

export interface RunnerResult {
  status: RunnerStatus;
  /** Drafts chosen by selection (assembled, verbatim from their notes). Present
   *  in both dry-run and apply runs. */
  selected: AssembledDraft[];
  /** Ids actually written this run. Empty when dry-run, or when selection chose
   *  none, or when every chosen id already existed (P2002). */
  created: string[];
  /** Chosen ids that already existed (P2002) — idempotent re-runs. */
  alreadyExisted: string[];
  rejected: RejectedCandidate[];
  candidateCount: number;
  dryRun: boolean;
  /** True iff a grounded rewrite actually ran this call (adaptDraft provided AND
   *  not dry-run). False on dry-run even when adaptDraft is wired. */
  adaptEnabled: boolean;
  /** Per-draft adapt outcomes. Empty unless `adaptEnabled`. */
  adapted: AdaptOutcome[];
  /** Per-draft slideshow-video outcomes. Empty on dry-run or when no drafts created. */
  videos: VideoOutcome[];
}

/** A draft created this run, carrying what the post-commit adapt needs. */
export interface CreatedRow {
  id: string;
  createdAt: Date;
  adaptSource: AdaptSource;
  /** Draft title, so applyAdapt can rebuild aiOriginal (adapt never changes title). */
  title: string;
  /** Draft images, so the adapt rewrite can re-embed them into the new body. */
  images?: string[];
}

/** Internal transaction return shape. The public RunnerResult is assembled only
 *  AFTER the post-commit adapt loop, so the model call never runs inside the tx. */
interface TxResult {
  status: RunnerStatus;
  selected: AssembledDraft[];
  createdRows: CreatedRow[];
  alreadyExisted: string[];
  rejected: RejectedCandidate[];
  candidateCount: number;
}

/** Duck-typed Prisma P2002 (unique-constraint) check — avoids importing the
 *  Prisma error class, keeping this module pure-loadable. Exported so the
 *  idempotency classification is unit-testable without the unreachable race
 *  (the advisory lock + unreviewed gate always intercept a duplicate first;
 *  this is the last-line defense for the fetch→create window). */
export function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code: unknown }).code === PRISMA_UNIQUE_VIOLATION
  );
}

/** Minimal client surface the post-commit adapt needs. Defined narrowly so the
 *  adapt DECISIONS are unit-testable with a hand-rolled fake; the injected
 *  PrismaClient satisfies it structurally (its article.updateMany accepts a
 *  superset of these args and returns {count:number}). */
export interface AdaptClient {
  article: {
    updateMany(args: {
      where: { id: string; updatedAt: Date; status: "draft" };
      data: {
        content: string;
        summary: string;
        /** Re-freeze the AI original to the adapt output (optional for fakes). */
        aiOriginal?: { title: string; content: string; summary: string };
      };
    }): Promise<{ count: number }>;
  };
}

/**
 * Phase D post-commit rewrite. Runs AFTER the transaction commits (caller
 * passes the created rows + the just-used prisma client as `writer`). Pure in
 * its decisions: for each created draft it calls `adaptDraft` once, and only
 * applies the result via a single conditional `updateMany` whose where-clause
 * requires `updatedAt === createdAt && status === "draft"` — so a human who
 * edited/published/archived in the meantime wins (count = 0 → skipped).
 *
 * Never throws: a throwing adaptDraft is recorded as ok:false and the verbatim
 * draft is kept. This function is the unit-test surface for adapt injection;
 * the full transaction path is covered by the DB integration test.
 */
export async function applyAdapt(opts: {
  writer: AdaptClient;
  createdRows: CreatedRow[];
  adaptDraft: (source: AdaptSource) => Promise<AdaptResult>;
}): Promise<AdaptOutcome[]> {
  const { writer, createdRows, adaptDraft } = opts;
  const adapted: AdaptOutcome[] = [];
  for (const row of createdRows) {
    let r: AdaptResult;
    try {
      r = await adaptDraft(row.adaptSource);
    } catch (e) {
      r = { ok: false, reason: `adapt threw: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!r.ok) {
      adapted.push({ id: row.id, ok: false, updated: false, reason: r.reason });
      continue;
    }
    const { count } = await writer.article.updateMany({
      where: { id: row.id, updatedAt: row.createdAt, status: "draft" },
      data: {
        content: r.content,
        summary: r.summary,
        // Keep aiOriginal in lockstep with the latest AI output, so the
        // 审校修改率 always diffs against what the human actually saw.
        aiOriginal: { title: row.title, content: r.content, summary: r.summary },
      },
    });
    adapted.push({
      id: row.id,
      ok: true,
      updated: count === 1,
      reason: count === 1 ? undefined : "human-edited; skipped",
    });
  }
  return adapted;
}

/** Minimum images for a slideshow video (mirrors generateSlideshowVideo's MIN_IMAGES). */
const VIDEO_MIN_IMAGES = 4;

/** Minimal client surface the post-commit video step needs. Defined narrowly so
 *  attachVideos is unit-testable with a hand-rolled fake; the injected PrismaClient
 *  satisfies it structurally (its article.updateMany accepts a superset). */
export interface VideoClient {
  article: {
    updateMany(args: {
      where: { id: string; status: "draft" };
      data: { videoUrl: string };
    }): Promise<{ count: number }>;
  };
}

export interface VideoOutcome {
  id: string;
  /** true iff a slideshow video was generated and written to the draft. */
  attached: boolean;
  /** undefined on success; reason when skipped (too few images / gen failed / published first). */
  reason?: string;
}

/**
 * Post-commit slideshow-video attachment. Runs AFTER the transaction + adapt
 * (caller passes the created rows + prisma as `writer`). For each created draft
 * with ≥ VIDEO_MIN_IMAGES images, generate a slideshow video from its images
 * and set videoUrl — so auto-drafts display as video (like the rest of the site)
 * instead of an inline-image wall.
 *
 * Never throws: a generateSlideshowVideo failure is recorded and the draft is
 * kept (prose-only, no video). The `status:"draft"` guard means a human who
 * published in the meantime wins (count = 0 → skipped). No-op when createdRows
 * is empty (dry-run) or images are too few. Video gen is ffmpeg, ~seconds each.
 */
export async function attachVideos(opts: {
  writer: VideoClient;
  createdRows: CreatedRow[];
  /** Injectable for tests; defaults to the real ffmpeg-based generator. */
  generateVideo?: (imageUrls: string[]) => Promise<{ videoUrl: string } | null>;
}): Promise<VideoOutcome[]> {
  const { writer, createdRows } = opts;
  const generateVideo = opts.generateVideo ?? generateSlideshowVideo;
  const out: VideoOutcome[] = [];
  for (const row of createdRows) {
    const images = row.images ?? [];
    if (images.length < VIDEO_MIN_IMAGES) {
      out.push({ id: row.id, attached: false, reason: `too few images (${images.length})` });
      continue;
    }
    let result: { videoUrl: string } | null = null;
    try {
      result = await generateVideo(images);
    } catch {
      result = null; // generator swallows; defensive
    }
    if (!result) {
      out.push({ id: row.id, attached: false, reason: "video generation failed" });
      continue;
    }
    let count = 0;
    try {
      const r = await writer.article.updateMany({
        where: { id: row.id, status: "draft" },
        data: { videoUrl: result.videoUrl },
      });
      count = r.count;
    } catch {
      count = 0;
    }
    out.push({
      id: row.id,
      attached: count === 1,
      reason: count === 1 ? undefined : "human-published-or-edited; skipped",
    });
  }
  return out;
}

/**
 * Run the tea-draft pipeline once. All DB work happens in a single interactive
 * `$transaction` (one connection) so the transaction-scoped advisory lock is
 * held for exactly the duration of the run and released on commit/rollback.
 *
 * Pass an injected `prisma` client — the CLI passes the production singleton,
 * the integration test passes a client built from an isolated `_test` DB.
 */
export async function runTeaDraftRunner(opts: {
  prisma: PrismaClient;
  config: RunnerConfig;
  dryRun?: boolean;
  /** Injectable clock for deterministic integration tests. */
  now?: () => Date;
  /** Phase D: optional grounded rewrite of just-created drafts. Omit for the
   *  pure verbatim path (current behavior). The model call runs AFTER the tx
   *  commits — never inside it — and on any failure the verbatim draft is kept. */
  adaptDraft?: (source: AdaptSource) => Promise<AdaptResult>;
}): Promise<RunnerResult> {
  const { prisma, config, dryRun = false } = opts;
  const now = opts.now ?? (() => new Date());

  const txResult = await prisma.$transaction<TxResult>(async (tx) => {
    // 1. Transaction-scoped advisory lock. A second concurrent runner (or a
    //    re-entrant cron tick) fails to acquire it and bows out immediately.
    const lockRows = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended('tea-draft-runner', 0)) AS locked`;
    if (!lockRows[0]?.locked) {
      return emptyTx("skipped-already-running");
    }

    // 2. Flood control: if `maxUnreviewed` auto-drafts are still awaiting
    //    review, create nothing. Bounds how many drafts can pile up before a
    //    human reviews them (default 10).
    const unreviewed = await tx.article.count({
      where: { id: { startsWith: TASTING_DRAFT_PREFIX }, status: "draft" },
    });
    if (unreviewed >= config.maxUnreviewed) {
      return emptyTx("skipped-unreviewed-exists");
    }

    // 3. Natural-day cap (Asia/Shanghai). Idempotent re-runs of an existing
    //    draft are caught above (unreviewed) or by P2002, so this mainly limits
    //    how fast NEW drafts accumulate across the day.
    const dayStart = startOfShanghaiDayUtc(now());
    const createdToday = await tx.article.count({
      where: { id: { startsWith: TASTING_DRAFT_PREFIX }, createdAt: { gte: dayStart } },
    });
    if (createdToday >= config.dailyCap) {
      return emptyTx("skipped-daily-cap");
    }

    // 4. Scoring context: teaId of the most recent reviewed/published auto-draft
    //    (for the diversity penalty). null when none exists yet.
    const latest = await tx.article.findFirst({
      where: {
        id: { startsWith: TASTING_DRAFT_PREFIX },
        status: { in: ["pending_review", "published"] },
      },
      orderBy: { createdAt: "desc" },
      select: { teaId: true },
    });
    const scoringCtx: ScoringContext = { recentAutoDraftTeaId: latest?.teaId ?? null };

    // 5. Bounded candidate fetch. The authorId + source filters make this
    //    selective; `take` is a hard backstop. Source accepts both curated
    //    manual notes and imported evernote tasting notes (same author's real
    //    reviews). The per-note allowlist still applies when non-empty.
    const noteIds = [...config.noteIds];
    const rows = (await tx.tastingNote.findMany({
      where: {
        source: { in: ["manual", "evernote"] },
        authorId: config.authorId,
        ...(noteIds.length > 0 ? { id: { in: noteIds } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: config.candidateFetchLimit,
    })) as TastingNoteLike[];
    if (rows.length === 0) {
      return emptyTx("no-candidates");
    }

    // 6. Prefetch DB facts: author liveness (one fetch — same author for every
    //    candidate) + which candidates already have a draft (batch by PK) +
    //    the set of teas already covered by ANY tasting-draft (tea-level dedup
    //    so the same product is never drafted twice from different notes).
    const author = await tx.user.findUnique({
      where: { id: config.authorId },
      select: { banStatus: true },
    });
    const authorActive = author !== null && author.banStatus === "active";
    const draftIds = rows.map((r) => tastingDraftId(r.id));
    const existing = await tx.article.findMany({
      where: { id: { in: draftIds } },
      select: { id: true },
    });
    const existingSet = new Set(existing.map((e) => e.id));
    const covered = await tx.article.findMany({
      where: { id: { startsWith: TASTING_DRAFT_PREFIX } },
      select: { teaId: true },
    });
    const coveredTeaIds = new Set(
      covered.map((c) => c.teaId).filter((t): t is string => t != null),
    );
    const factsByNote = new Map<string, CandidateFacts>();
    for (const r of rows) {
      factsByNote.set(r.id, {
        authorActive,
        existingDraftExists: existingSet.has(tastingDraftId(r.id)),
        teaAlreadyCovered: r.teaId != null && coveredTeaIds.has(r.teaId),
      });
    }

    // 7. Pure selection (no DB). Verbatim assembly, no model.
    const candidates = rows.map(normalizeTastingNote);
    const { selected, rejected } = selectDrafts({ candidates, factsByNote, scoringCtx, config });

    // 7b. Derive the (pure) adapt source for each selected draft now, so the
    //     post-commit rewrite has everything it needs without re-reading the
    //     note. No network here — toAdaptSource is a pure projection.
    const candidateById = new Map(candidates.map((c) => [c.id, c]));
    const adaptSourceByDraftId = new Map<string, AdaptSource>();
    for (const draft of selected) {
      const noteId = noteIdFromDraftId(draft.id);
      const note = noteId ? candidateById.get(noteId) : undefined;
      if (note) adaptSourceByDraftId.set(draft.id, toAdaptSource(note));
    }

    // 8. Write (skip entirely on dry-run). P2002 on the deterministic PK means
    //    the draft already exists — idempotent, not an error. Capture createdAt
    //    so the post-commit adapt can guard against a concurrent human edit.
    const createdRows: CreatedRow[] = [];
    const alreadyExisted: string[] = [];
    if (!dryRun) {
      for (const draft of selected) {
        try {
          const created = await tx.article.create({
            data: {
              id: draft.id,
              type: draft.type,
              title: draft.title,
              content: draft.content,
              summary: draft.summary,
              // Freeze the assembly original for the 审校修改率 baseline. Human
              // edits only ever touch content/summary/title — never this column.
              aiOriginal: { title: draft.title, content: draft.content, summary: draft.summary },
              boardId: draft.boardId,
              teaId: draft.teaId,
              tags: draft.tags,
              status: draft.status,
              authorId: draft.authorId,
              brewMethod: draft.brewMethod,
              waterTemp: draft.waterTemp,
              teaWeight: draft.teaWeight,
              steepCount: draft.steepCount,
              images: draft.images,
              videoUrl: draft.videoUrl,
            },
            select: { id: true, createdAt: true },
          });
          const adaptSource = adaptSourceByDraftId.get(draft.id);
          if (adaptSource) {
            createdRows.push({ id: created.id, createdAt: created.createdAt, adaptSource, title: draft.title, images: draft.images });
          }
        } catch (e) {
          if (isUniqueViolation(e)) {
            alreadyExisted.push(draft.id);
          } else {
            throw e;
          }
        }
      }
    }

    return {
      status: "ok",
      selected,
      createdRows,
      alreadyExisted,
      rejected,
      candidateCount: rows.length,
    };
  });

  // Phase D: grounded rewrite runs AFTER the tx commits — no model call ever
  // holds the advisory lock or a DB connection. Each update is conditional on
  // updatedAt === createdAt && status === "draft", so a human who edited /
  // published / archived the draft in the meantime wins (count = 0 → skip),
  // matching Phase A's publishArticles winner semantics.
  const adaptEnabled = !!opts.adaptDraft && !dryRun;
  const adapted =
    adaptEnabled && opts.adaptDraft
      ? await applyAdapt({
          writer: prisma,
          createdRows: txResult.createdRows,
          adaptDraft: opts.adaptDraft,
        })
      : [];

  // Slideshow-video attachment: post-commit (ffmpeg, holds no lock). No-op in
  // dry-run (createdRows empty) and for drafts with < VIDEO_MIN_IMAGES images.
  const videos = await attachVideos({ writer: prisma, createdRows: txResult.createdRows });

  return {
    status: txResult.status,
    selected: txResult.selected,
    created: txResult.createdRows.map((r) => r.id),
    alreadyExisted: txResult.alreadyExisted,
    rejected: txResult.rejected,
    candidateCount: txResult.candidateCount,
    dryRun,
    adaptEnabled,
    adapted,
    videos,
  };
}

function emptyTx(status: RunnerStatus): TxResult {
  return { status, selected: [], createdRows: [], alreadyExisted: [], rejected: [], candidateCount: 0 };
}

export const RUNNER_DEFAULTS = {
  limit: 1,
  dailyCap: 1,
  maxUnreviewed: 10,
  candidateFetchLimit: DEFAULT_CANDIDATE_FETCH_LIMIT,
} as const;
