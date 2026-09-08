/**
 * Deterministic Article ID for a tasting-note draft.
 *
 * Design constraint (v1): no DB schema change, so idempotency of "one draft per
 * note" rests on the Article PRIMARY KEY. We therefore derive the draft's id
 * from the note's id: `tasting-draft_${noteId}`. A second run for the same
 * note collides on the PK (Prisma P2002) and is treated as "already created".
 *
 * Pure, zero imports. Safe under `node --test`.
 */

const PREFIX = "tasting-draft_";

/**
 * Accepts Prisma cuid() ids (lowercase alphanumerics, typically 24 chars) AND
 * UUID-style ids (hex groups joined by `-`, as used by imported evernote notes).
 * We reject anything containing the `_` separator (would corrupt reversibility
 * since `_` is the prefix separator) or other non-cuid/uuid characters, so a
 * malformed id can never silently produce a draft.
 */
const NOTE_ID_RE = /^[a-z0-9-]{16,}$/;

/** Build the deterministic draft id for a note id. Throws on a malformed id. */
export function tastingDraftId(noteId: string): string {
  if (typeof noteId !== "string" || !NOTE_ID_RE.test(noteId)) {
    throw new Error(`Invalid noteId for tasting draft id: ${String(noteId)}`);
  }
  return PREFIX + noteId;
}

/** True iff `id` is a tasting-draft id (regardless of suffix validity). */
export function isTastingDraftId(id: string): boolean {
  return typeof id === "string" && id.startsWith(PREFIX);
}

/**
 * Reverse `tastingDraftId`. Returns the note id, or `null` if `id` is not a
 * tasting-draft id or its suffix is not a valid cuid. Used by the admin review
 * UI to link a draft back to its source note.
 */
export function noteIdFromDraftId(id: string): string | null {
  if (!isTastingDraftId(id)) return null;
  const noteId = id.slice(PREFIX.length);
  return NOTE_ID_RE.test(noteId) ? noteId : null;
}
