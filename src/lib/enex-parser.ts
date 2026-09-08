import { parseStringPromise } from "xml2js";

export interface EnexNote {
  title: string;
  content: string; // HTML content
  created: Date;
  updated: Date;
  tags: string[];
  noteAttributes?: Record<string, string>;
}

export interface EnexParseResult {
  notes: EnexNote[];
  errors: { index: number; error: string }[];
}

/**
 * Parse an ENEX file (Evernote export) into structured notes.
 */
export async function parseEnex(enexContent: string): Promise<EnexParseResult> {
  const result = await parseStringPromise(enexContent, {
    explicitArray: false,
    ignoreAttrs: true,
  });

  const exportData = result["en-export"] || result;
  const rawNotes = exportData?.note;

  if (!rawNotes) {
    return { notes: [], errors: [] };
  }

  const notes: EnexNote[] = [];
  const errors: { index: number; error: string }[] = [];

  // xml2js returns single object for one note, array for multiple
  const noteList = Array.isArray(rawNotes) ? rawNotes : [rawNotes];

  for (let i = 0; i < noteList.length; i++) {
    try {
      const raw = noteList[i];
      const title = raw.title || `未命名笔记 ${i + 1}`;
      const content = stripEnml(raw.content || "");

      const created = parseEvernoteDate(raw.created);
      const updated = parseEvernoteDate(raw.updated);

      const tags = raw.tag
        ? Array.isArray(raw.tag)
          ? raw.tag
          : [raw.tag]
        : [];

      notes.push({ title, content, created, updated, tags });
    } catch (err) {
      errors.push({
        index: i,
        error: err instanceof Error ? err.message : "解析失败",
      });
    }
  }

  return { notes, errors };
}

/**
 * Strip ENML envelope and return clean HTML.
 */
function stripEnml(content: string): string {
  return content
    .replace(/<\?xml[^?]*\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/g, "")
    .replace(/<\/?en-note[^>]*>/g, "")
    .replace(/<\/?en-media[^>]*\/?>/g, "")
    .replace(/<\/?en-crypt[^>]*>.*?<\/en-crypt>/g, "")
    .replace(/<\/?en-todo[^>]*\/?>/g, "")
    .trim();
}

/**
 * Parse Evernote date format: 20240115T123000Z
 */
function parseEvernoteDate(dateStr: string): Date {
  if (!dateStr) return new Date();

  const match = dateStr.match(
    /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/
  );
  if (!match) return new Date();

  const [, y, mo, d, h, mi, s] = match;
  return new Date(
    Date.UTC(parseInt(y), parseInt(mo) - 1, parseInt(d), parseInt(h), parseInt(mi), parseInt(s))
  );
}
