/**
 * Project a TastingNote DB row into the flat shape the pure draft modules use.
 *
 * Pure: it ONLY copies fields and coerces `createdAt` to an epoch-ms number
 * for stable sorting. It never rewrites, interprets, or truncates content.
 * The raw HTML stays in `content` for `source-html.ts` to parse later.
 *
 * Zero `@/` imports (runs under `node --test`).
 */

/** The note as the draft pipeline consumes it. */
export interface NormalizedNote {
  id: string;
  title: string;
  /** Raw, UNTRUSTED HTML from the note body. Parsed only by source-html.ts. */
  content: string;
  summary: string | null;
  teaId: string;
  /**
   * Product name of `teaId`, from the `Tea` row — NOT a TastingNote column.
   * Prefetched by the runner and stamped on here so `assembleTitle` can use the
   * product name as the draft title. `null` when the note has no tea row (or no
   * name), which is the signal to fall back to the note's own title.
   */
  teaName: string | null;
  authorId: string;
  /** "evernote" | "manual" | "import" (DB default "evernote"). */
  source: string;
  brewMethod: string | null;
  waterTemp: number | null;
  teaWeight: string | null;
  steepCount: number | null;
  /** Raw `images` Json value (array of URL strings expected, but untyped). */
  images: unknown;
  videoUrl: string | null;
  /** epoch-ms, for deterministic stable sort. */
  createdAt: number;
}

/** Subset of Prisma's TastingNote that normalizeTastingNote reads (`teaName` is an optional join from `Tea`). */
export interface TastingNoteLike {
  id: string;
  title: string;
  content: string;
  summary?: string | null;
  teaId: string;
  /** Optional — set when the caller joined/prefetched the `Tea` name. */
  teaName?: string | null;
  authorId: string;
  source: string;
  brewMethod?: string | null;
  waterTemp?: number | null;
  teaWeight?: string | null;
  steepCount?: number | null;
  images?: unknown;
  videoUrl?: string | null;
  /** Date | ISO string | epoch-ms number. */
  createdAt: Date | string | number;
}

function toEpochMs(d: Date | string | number): number {
  if (d instanceof Date) return d.getTime();
  if (typeof d === "number") return d;
  // ISO string → epoch ms. NaN propagates (caller's bad data, not our rewrite).
  return Date.parse(d);
}

/** Copy fields verbatim; coerce createdAt to epoch ms; default nulls. */
export function normalizeTastingNote(note: TastingNoteLike): NormalizedNote {
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    summary: note.summary ?? null,
    teaId: note.teaId,
    teaName: note.teaName ?? null,
    authorId: note.authorId,
    source: note.source,
    brewMethod: note.brewMethod ?? null,
    waterTemp: note.waterTemp ?? null,
    teaWeight: note.teaWeight ?? null,
    steepCount: note.steepCount ?? null,
    images: note.images ?? null,
    videoUrl: note.videoUrl ?? null,
    createdAt: toEpochMs(note.createdAt),
  };
}
