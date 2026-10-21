/**
 * F0 content-origin policy — pure functions, zero imports, unit-tested.
 *
 * PRD v0.3 §6 / F0: every piece of forum content must be classifiable into
 * exactly one of three origins, and the classification must drive BOTH the
 * front-end disclosure label and the one-way flow rule (AI content can never
 * become TastingNote data, the editor/owner line, or the community band).
 *
 *   human          — written by a real person (incl. the editor/owner line).
 *   ai_from_notes  — AI-generated FROM the editor's own tasting notes,
 *                    reviewed by a human before publication.
 *   ai_autonomous  — AI retrieves / picks / writes on its own (market news),
 *                    not based on any editor tasting note.
 *
 * Classification for NEW content is explicit (the pipeline writes it). This
 * module also handles classification of EXISTING rows, where origin has to be
 * inferred from signals already in the data. Inference rules are deliberately
 * conservative: when the evidence is ambiguous the row is classified as
 * `human`, because mislabelling a human post as AI is a defamation-style error
 * and the one-way-flow rule is already enforced on the write path.
 *
 * Run: npm run test:unit
 */

export const ORIGIN_HUMAN = "human" as const;
export const ORIGIN_AI_FROM_NOTES = "ai_from_notes" as const;
export const ORIGIN_AI_AUTONOMOUS = "ai_autonomous" as const;

export type ArticleOrigin =
  | typeof ORIGIN_HUMAN
  | typeof ORIGIN_AI_FROM_NOTES
  | typeof ORIGIN_AI_AUTONOMOUS;

export const ORIGIN_VALUES: readonly ArticleOrigin[] = [
  ORIGIN_HUMAN,
  ORIGIN_AI_FROM_NOTES,
  ORIGIN_AI_AUTONOMOUS,
];

/**
 * Front-end disclosure copy. `human` intentionally maps to null — human posts
 * carry no label at all; the label is the signal, labelling everything
 * dilutes it.
 */
export const DISCLOSURE_LABELS: Record<Exclude<ArticleOrigin, "human">, string> = {
  ai_from_notes: "站长笔记 · AI 整理",
  ai_autonomous: "AI 生成 · 非站长品鉴",
};

// ── Row-level signals used to infer the origin of existing articles ───────

export interface OriginSignals {
  /** Primary key. The two AI pipelines use fixed, prefixed ids. */
  id: string;
  /** Post body. Both legacy host pipelines embed an HTML comment marker. */
  content: string | null;
  /** Set when a draft went through the tea-draft AI rewrite layer. */
  hasAiOriginal: boolean;
  /**
   * Whether the author is a synthetic (automated) account. Author identity
   * alone is NOT proof of AI — synthetic accounts also hold hand-seeded
   * follow-up posts — but it is required to recognise the autonomous bot
   * posts whose only signal is their account.
   */
  authorIsSynthetic: boolean;
  /** Only published posts are expected to carry review metadata. */
  status: string;
}

const NEWS_DRAFT_PREFIX = "news-draft_";
const TASTING_DRAFT_PREFIX = "tasting-draft_";
// Legacy host pipelines stamp an HTML comment the front-end never renders:
//   <!--auto-post:{noteId}--> / <!--rag-post:{hash}-->
const AUTOPOST_MARKER_RE = /<!--\s*auto-post(?::|--|\s)/;
const RAGPOST_MARKER_RE = /<!--\s*rag-post(?::|--|\s)/;

export function hasAutopostMarker(content: string | null | undefined): boolean {
  return typeof content === "string" && AUTOPOST_MARKER_RE.test(content);
}

export function hasRagpostMarker(content: string | null | undefined): boolean {
  return typeof content === "string" && RAGPOST_MARKER_RE.test(content);
}

export function isNewsDraftId(id: string): boolean {
  return typeof id === "string" && id.startsWith(NEWS_DRAFT_PREFIX);
}

export function isTastingDraftId(id: string): boolean {
  return typeof id === "string" && id.startsWith(TASTING_DRAFT_PREFIX);
}

/**
 * Infer the origin of a row from its stored signals.
 *
 * Precedence matters and is strongest-signal-first:
 *
 *  1. `news-draft_*` id → ai_autonomous. The weekly PentAGI pipeline retrieves
 *     external material; no editor tasting note is involved. Nothing written
 *     under this id can ever be anything else.
 *
 *  2. `tasting-draft_*` id, an auto-post/rag-post marker, OR aiOriginal set →
 *     ai_from_notes. All three prove the content came from the editor's own
 *     note corpus through an AI step. This outranks the synthetic-author rule
 *     below: those drafts are frequently published under a bot account, yet
 *     what they ARE is an AI rendering of the editor's notes — the more
 *     informative and more honest label.
 *
 *  3. Author is a synthetic (system-controlled) account → ai_autonomous. F0:
 *     「凡由系统控制的账号…不得以真人身份出现」. A bot-authored post is
 *     machine-produced content, so calling it `human` would let it pass as a
 *     real person's record — and would let it into the TastingNote data layer.
 *
 *  4. Otherwise → human.
 */
export function classifyOrigin(s: OriginSignals): ArticleOrigin {
  if (isNewsDraftId(s.id)) return ORIGIN_AI_AUTONOMOUS;

  if (
    isTastingDraftId(s.id) ||
    s.hasAiOriginal ||
    hasAutopostMarker(s.content) ||
    hasRagpostMarker(s.content)
  ) {
    return ORIGIN_AI_FROM_NOTES;
  }

  if (s.authorIsSynthetic) return ORIGIN_AI_AUTONOMOUS;

  return ORIGIN_HUMAN;
}

/**
 * Parse an origin value coming out of the database / API. Unknown values must
 * not crash a reader — they fall back to `human` (same conservative default as
 * inference). Returns null only when the input is null/undefined (column not
 * populated yet), so callers can tell "not backfilled" apart from "human".
 */
export function parseOrigin(raw: unknown): ArticleOrigin | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return ORIGIN_HUMAN;
  return (ORIGIN_VALUES as readonly string[]).includes(raw)
    ? (raw as ArticleOrigin)
    : ORIGIN_HUMAN;
}

/** The disclosure label a front-end should render for an origin; null = none. */
export function disclosureLabelFor(origin: ArticleOrigin | null | undefined): string | null {
  if (origin === ORIGIN_AI_FROM_NOTES) return DISCLOSURE_LABELS.ai_from_notes;
  if (origin === ORIGIN_AI_AUTONOMOUS) return DISCLOSURE_LABELS.ai_autonomous;
  return null;
}

/**
 * F0 one-way flow: may content of this origin feed the TastingNote data layer
 * (editor line / community band)? Only genuine human content may. This is the
 * single predicate every write path that touches tasting_notes MUST consult.
 */
export function originCanFeedDataLayer(origin: ArticleOrigin | null | undefined): boolean {
  return origin === ORIGIN_HUMAN;
}
