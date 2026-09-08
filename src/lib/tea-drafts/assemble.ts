/**
 * Assemble a draft Article from a normalized tasting note — the composition
 * core of the trustworthy-draft pipeline.
 *
 * Trust contract: every fragment in the output is traceable to either
 *   (a) the note's own prose, preserved VERBATIM in original order (only
 *       empty/exact-duplicate/exact-boilerplate paragraphs are dropped), or
 *   (b) a fixed, neutral section ("冲泡记录") built ONLY from the note's brew
 *       fields, with fixed labels, or
 *   (c) a fixed label/heading emitted by this module.
 * Nothing is invented, paraphrased, or model-generated. The numeric tasting
 * scores are NEVER written — not to `tastingScores`, not into the body, not
 * into the summary. (If the author's own prose mentions a score, that prose is
 * preserved verbatim — which is exactly the "traceable to source" promise.)
 *
 * Pure: no DB, no network, no model. Safe under `node --test`.
 */
import { tastingDraftId } from "./id.ts";
import { extractParagraphs } from "./source-html.ts";
import type { NormalizedNote } from "./normalize.ts";

/** AUTO_TEA_DRAFT_BOARD_ID — the board auto-drafts are posted to. */
export interface AssembleConfig {
  boardId: string;
}

export interface AssembledDraft {
  id: string;
  type: "tasting";
  title: string;
  content: string;
  summary: string | null;
  tags: string[];
  status: "draft";
  authorId: string;
  boardId: string;
  teaId: string;
  brewMethod: string | null;
  waterTemp: number | null;
  teaWeight: string | null;
  steepCount: number | null;
  images: string[];
  videoUrl: string | null;
}

/** DB column caps (Article.title VarChar(200), Article.summary VarChar(500)). */
export const TITLE_MAX_LENGTH = 200;
export const SUMMARY_MAX_LENGTH = 500;

const EMPTY_SET: ReadonlySet<string> = new Set();

const BREW_LABELS = {
  brewMethod: "冲泡方式",
  waterTemp: "水温",
  teaWeight: "投茶量",
  steepCount: "耐泡度",
} as const;

const SENTENCE_SPLIT = /(?<=[。！？!?;；])/;

/** HTML-escape the characters that matter for text-node injection. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Media URL allowlist: site-relative `/uploads/...` OR `https://...` only.
 * Rejects data:/javascript:/file:/vbscript:, bare http, protocol-relative
 * (`//host`), and any unknown scheme. Used here for copy-through and by the
 * runner for the scoring pre-filter.
 */
export function isAllowedMediaUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const u = url.trim();
  if (!u) return false;
  if (/^(data|javascript|file|vbscript):/i.test(u)) return false;
  if (u.startsWith("/uploads/")) return true;
  if (/^https:\/\/[^\s'"<>]+$/i.test(u)) return true;
  return false;
}

function clipToCodepoints(s: string, max: number): string {
  const cps = [...s];
  return cps.length <= max ? s : cps.slice(0, max).join("");
}

function foldWhitespace(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Evernote attachment markers (e.g. "[附件: image/jpeg]", "[附件]") left behind
 * as literal text when a note's `<en-media>` tags were flattened during import.
 * They are NOT content — the real images live in `note.images` and render via
 * the gallery — so they must never reach the published body or summary. If a
 * paragraph is only placeholders, it becomes empty and is dropped.
 */
const ATTACHMENT_PLACEHOLDER = /\[附件[^\]]*\]/g;

/** Remove Evernote attachment placeholders, then re-collapse whitespace. */
function stripAttachmentPlaceholders(p: string): string {
  return foldWhitespace(p.replace(ATTACHMENT_PLACEHOLDER, ""));
}

function assembleTitle(raw: string): string {
  return clipToCodepoints(foldWhitespace(raw), TITLE_MAX_LENGTH);
}

/** When a sentence exceeds the cap, cut after the last terminator ≤ cap; else hard-clip. */
function clipAtSentenceBoundary(s: string, max: number): string {
  const cps = [...s];
  if (cps.length <= max) return s;
  const head = cps.slice(0, max).join("");
  const re = /[。！？!?;；]/g;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(head)) !== null) last = m.index;
  return last >= 0 ? head.slice(0, last + 1) : head;
}

function stripTrailingTerminators(s: string): string {
  return s.replace(/[。！？!?;；]+$/, "");
}

function assembleSummary(paragraphs: string[], title: string): string | null {
  if (paragraphs.length === 0) return null;
  const sentences = paragraphs[0]
    .split(SENTENCE_SPLIT)
    .map(foldWhitespace)
    .filter(Boolean);
  // First complete, non-empty sentence that is not a verbatim repeat of the
  // title. Compare on terminator-stripped cores so "标题。" vs "标题" matches.
  const picked =
    sentences.find((s) => stripTrailingTerminators(s) !== stripTrailingTerminators(title)) ?? null;
  if (!picked) return null;
  return clipAtSentenceBoundary(picked, SUMMARY_MAX_LENGTH) || null;
}

function coerceStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function assembleMedia(note: NormalizedNote): { images: string[]; videoUrl: string | null } {
  const images = coerceStringArray(note.images).filter(isAllowedMediaUrl);
  const videoUrl = note.videoUrl && isAllowedMediaUrl(note.videoUrl) ? note.videoUrl : null;
  return { images, videoUrl };
}

function assembleBody(
  paragraphs: string[],
  note: NormalizedNote,
  boilerplate: ReadonlySet<string>,
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of paragraphs) {
    const t = foldWhitespace(raw);
    if (!t) continue; // empty paragraph (extractParagraphs already drops these)
    if (seen.has(t)) continue; // exact duplicate — keep first
    seen.add(t);
    if (boilerplate.has(t)) continue; // exact-match import boilerplate
    parts.push(`<p>${escapeHtml(t)}</p>`);
  }

  // Generated neutral brew-record section, only from non-empty fields.
  const items: string[] = [];
  if (note.brewMethod) items.push(`<li>${BREW_LABELS.brewMethod}：${escapeHtml(note.brewMethod)}</li>`);
  if (note.waterTemp != null)
    items.push(`<li>${BREW_LABELS.waterTemp}：${escapeHtml(String(note.waterTemp))}℃</li>`);
  if (note.teaWeight) items.push(`<li>${BREW_LABELS.teaWeight}：${escapeHtml(note.teaWeight)}</li>`);
  if (note.steepCount != null)
    items.push(`<li>${BREW_LABELS.steepCount}：${escapeHtml(String(note.steepCount))}</li>`);
  if (items.length > 0) parts.push(`<h2>冲泡记录</h2><ul>${items.join("")}</ul>`);

  return parts.join("");
}

/**
 * Compose the draft. The caller is responsible for running hard-gates first
 * (so title is non-empty and content is long enough); assemble itself is a
 * pure transform and does not re-validate eligibility.
 */
export function assembleDraft(input: {
  note: NormalizedNote;
  config: AssembleConfig;
  /** Optional exact-match paragraph strings to drop as import boilerplate. */
  boilerplate?: ReadonlySet<string>;
}): AssembledDraft {
  const { note, config } = input;
  const boilerplate = input.boilerplate ?? EMPTY_SET;
  // Strip Evernote attachment markers BEFORE body/summary so they never leak as
  // literal "[附件: image/jpeg]" text (images render via the gallery instead).
  const paragraphs = extractParagraphs(note.content)
    .map(stripAttachmentPlaceholders)
    .filter(Boolean);
  const title = assembleTitle(note.title);
  const media = assembleMedia(note);
  return {
    id: tastingDraftId(note.id),
    type: "tasting",
    title,
    content: assembleBody(paragraphs, note, boilerplate),
    summary: assembleSummary(paragraphs, title),
    tags: ["品鉴"],
    status: "draft",
    authorId: note.authorId,
    boardId: config.boardId,
    teaId: note.teaId,
    brewMethod: note.brewMethod,
    waterTemp: note.waterTemp,
    teaWeight: note.teaWeight,
    steepCount: note.steepCount,
    images: media.images,
    videoUrl: media.videoUrl,
  };
}
