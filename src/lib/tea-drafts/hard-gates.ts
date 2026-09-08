/**
 * Hard gates — the fail-closed eligibility check for a tasting-note draft.
 *
 * A note is selected ONLY if it passes EVERY gate. Any miss → a structured
 * rejection reason and zero drafts (no random fallback). This is where the
 * "trustworthy source" guarantee starts: only the configured author's own
 * manually-entered OR imported (evernote) notes, with enough real content, and
 * no repost/aggregation boilerplate, may become a draft.
 *
 * Pure: the two facts that need the DB (author exists & not banned; a draft
 * with the deterministic id already exists) are pre-fetched by the runner and
 * passed in via `HardGateContext`. Given the inputs, the verdict is fully
 * deterministic — safe under `node --test`.
 */
import { extractPlainText, codepointLength } from "./source-html.ts";

/** Operator configuration (from env at runtime, injected here for purity). */
export interface HardGateConfig {
  /** The single user id allowed to originate auto-drafts (AUTO_TEA_DRAFT_AUTHOR_ID). */
  authorId: string;
  /** Operator-curated note-id allowlist (AUTO_TEA_DRAFT_NOTE_IDS). */
  noteIds: ReadonlySet<string>;
}

/** DB-dependent facts, pre-fetched by the runner. */
export interface HardGateContext {
  /** False if the author is missing or banned. */
  authorActive: boolean;
  /** True if an Article with the deterministic id already exists. */
  existingDraftExists: boolean;
  /** True if any tasting-draft Article already covers this note's tea — i.e. a
   *  different note of the SAME tea has already been drafted. Tea-level dedup
   *  so the same product is never posted twice. */
  teaAlreadyCovered: boolean;
}

export interface HardGateResult {
  pass: boolean;
  /** Structured reason for a failure; undefined when pass === true. */
  reason?: string;
}

export type HardGateRejectionReason =
  | "source_not_manual"
  | "author_not_configured"
  | "note_not_in_allowlist"
  | "author_inactive_or_banned"
  | "draft_already_exists"
  | "tea_already_covered"
  | "empty_title"
  | "content_too_short"
  | "disqualifying_signal";

/** Sources accepted as trustworthy for drafting: operator-curated manual notes
 *  plus imported evernote tasting notes (same author's real reviews, only the
 *  storage origin differs). */
const ACCEPTED_SOURCES: ReadonlySet<string> = new Set(["manual", "evernote"]);
export const MIN_SAFE_TEXT_CODEPOINTS = 80;

/**
 * Signals that mark a note as a repost / aggregated / copyrighted borrow rather
 * than an original tasting. Their presence disqualifies the note entirely.
 */
const DISQUALIFYING_SIGNALS: readonly RegExp[] = [
  /转发/,
  /转载/,
  /原文(?:链接|地址)?\s*[:：]/,
  /来源\s*[:：]/,
  /版权归原作者/,
  /版权所有/,
  /侵权[请必]/,
  /本文转自/,
  /摘自/,
  /via\s/i,
];

export interface HardGateNote {
  id: string;
  authorId: string;
  source: string;
  title: string;
  content: string;
  /** Tea this note reviews; null on notes that somehow lack one. */
  teaId: string | null;
}

/**
 * Evaluate every gate in fail-closed order. Returns the first failure (or pass).
 * The DB-backed gates run first so a banned author or pre-existing draft is
 * rejected before any content is parsed.
 */
export function checkHardGates(
  note: HardGateNote,
  config: HardGateConfig,
  ctx: HardGateContext,
): HardGateResult {
  if (!ACCEPTED_SOURCES.has(note.source)) return fail("source_not_manual");
  if (note.authorId !== config.authorId) return fail("author_not_configured");
  // Empty allowlist = wildcard mode: any of the configured author's notes is
  // eligible (the author + source + tea-dedup gates still bound the set).
  if (config.noteIds.size > 0 && !config.noteIds.has(note.id)) {
    return fail("note_not_in_allowlist");
  }
  if (!ctx.authorActive) return fail("author_inactive_or_banned");
  if (ctx.existingDraftExists) return fail("draft_already_exists");
  if (ctx.teaAlreadyCovered) return fail("tea_already_covered");

  const title = (note.title ?? "").trim();
  if (!title) return fail("empty_title");

  const safeText = extractPlainText(note.content ?? "");
  if (codepointLength(safeText) < MIN_SAFE_TEXT_CODEPOINTS) {
    return fail("content_too_short");
  }

  const hay = `${title}\n${safeText}`;
  for (const re of DISQUALIFYING_SIGNALS) {
    if (re.test(hay)) return fail("disqualifying_signal");
  }
  return { pass: true };
}

function fail(reason: HardGateRejectionReason): HardGateResult {
  return { pass: false, reason };
}
