/**
 * Fixed-table scoring + stable ranking of eligible tasting notes.
 *
 * Deterministic by construction: a fixed score table, a fixed threshold, and a
 * fixed sort tuple. No model, no weights learned from data. The scoring fields
 * (appearance/color/aroma/...) NEVER participate in the score — they are
 * subjective and must not influence selection.
 *
 * Pure: takes plain numbers/strings (content text is parsed via source-html for
 * the length band; media arrive as already-validated counts). Safe under
 * `node --test`.
 */
import { extractPlainText, codepointLength } from "./source-html.ts";

/** Facts the runner pre-fetches (the most-recent auto-draft's teaId). */
export interface ScoringContext {
  /** teaId of the latest pending_review/published auto-draft, or null if none. */
  recentAutoDraftTeaId: string | null;
}

export interface ScoredCandidate {
  id: string;
  score: number;
  /** epoch-ms, used only as a stable tie-breaker. */
  createdAt: number;
}

/** Fields scoring reads from a normalized note (plus validated media counts). */
export interface ScoringInput {
  id: string;
  createdAt: number;
  /** Raw HTML; only its flat text length is used. */
  content: string;
  teaId: string;
  brewParams: {
    brewMethod: string | null;
    waterTemp: number | null;
    teaWeight: string | null;
    steepCount: number | null;
  };
  /** Count of URL-validated images (runner pre-validates). */
  imageCount: number;
  /** Non-null only when a valid videoUrl is present (runner pre-validates). */
  videoUrl: string | null;
}

/** Minimum total score to be selected as a draft. */
export const SCORE_THRESHOLD = 2;

function contentLengthScore(codepoints: number): number {
  if (codepoints >= 800) return 3;
  if (codepoints >= 200) return 2;
  if (codepoints >= 80) return 1;
  // Below the hard-gate minimum; scored 0 (and would already be gated out).
  return 0;
}

function countNonEmptyBrewParams(p: ScoringInput["brewParams"]): number {
  const vals = [p.brewMethod, p.waterTemp, p.teaWeight, p.steepCount];
  return vals.filter((v) => v !== null && v !== undefined && String(v).trim() !== "").length;
}

/**
 * Score a single candidate on the fixed table. The teaId diversity penalty
 * only applies when there is a known recent auto-draft with the SAME teaId.
 */
export function scoreCandidate(note: ScoringInput, ctx: ScoringContext): ScoredCandidate {
  let score = 0;
  score += contentLengthScore(codepointLength(extractPlainText(note.content)));
  if (countNonEmptyBrewParams(note.brewParams) >= 2) score += 1;
  if (note.imageCount >= 4) score += 1;
  if (note.videoUrl) score += 1;
  if (ctx.recentAutoDraftTeaId !== null && note.teaId === ctx.recentAutoDraftTeaId) {
    score -= 1;
  }
  return { id: note.id, score, createdAt: note.createdAt };
}

/**
 * Stable rank: score DESC, then createdAt DESC (newer first), then id ASC.
 * Returns a new array; the input is not mutated.
 */
export function rankCandidates(cands: readonly ScoredCandidate[]): ScoredCandidate[] {
  return [...cands].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}
