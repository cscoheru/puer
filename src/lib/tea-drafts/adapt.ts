/**
 * Phase D — grounded LLM adaptation of a tasting-note draft.
 *
 * This is the ONLY place in the tea-draft pipeline that may call a language
 * model, and only to REWRITE the body/summary of a draft that has already
 * passed the hard gates and been deterministically created (status=draft). It
 * must never decide WHICH note becomes a draft, never write tastingScores,
 * never auto-publish, and never invent facts the source note does not contain.
 *
 * Safety model (defense in depth):
 *   1. Numeric grounding — every arabic-digit run in the adapted text must
 *      already appear in the source corpus (blocks invented years / scores /
 *      weights / temps / steep counts).
 *   2. Length bounds vs source (30%–150%) + absolute min/max.
 *   3. Output HTML is passed through sanitizeNoteHtml — the SAME gate as the
 *      verbatim path — so script, iframe, on* handlers, style, and dangerous
 *      URL schemes are stripped. Then stripToContentTags enforces the prompt's
 *      tag whitelist (p/b/i/h2/ul/li + harmless equivalents) and drops every
 *      attribute, so a model that ignores the prompt cannot inject a link or
 *      tracking pixel.
 *   4. Any failure (missing key, network error, bad JSON, grounding/length/
 *      sanitize violation) returns {ok:false,reason}; the caller keeps the
 *      already-created verbatim draft. This function NEVER throws.
 *
 * The DeepSeek call mirrors src/lib/moderation.ts (same endpoint, same env
 * key) but at temperature 0.4 (grounded), not the retired creative 0.9, with a
 * json_object response format and a 20s timeout.
 */
import { extractPlainText, codepointLength } from "./source-html.ts";
import { sanitizeNoteHtml, stripToContentTags } from "./sanitize.ts";
import { escapeHtml, SUMMARY_MAX_LENGTH } from "./assemble.ts";
import type { NormalizedNote } from "./normalize.ts";

// DeepSeek config — mirrors src/lib/moderation.ts. Those consts are
// module-private there, so they are re-declared here to keep the adapter free
// of a runtime dependency on the moderation module's side effects.
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

// Adaptation knobs (deliberately tighter than the retired creative rewrite).
const ADAPT_TIMEOUT_MS = 20_000;
const ADAPT_TEMPERATURE = 0.4;
const ADAPT_MAX_TOKENS = 800;
const ADAPT_MIN_CODEPOINTS = 60;
const ADAPT_MAX_CODEPOINTS = 2000; // hard ceiling independent of ratio
const ADAPT_RATIO_MIN = 0.3;
const ADAPT_RATIO_MAX = 1.5;

export interface AdaptBrewFields {
  method: string | null;
  temp: number | null;
  weight: string | null;
  steep: number | null;
}

/** Everything the adapter needs, derived purely from a normalized note. */
export interface AdaptSource {
  title: string;
  plainText: string; // HTML-stripped body: prompt input + length-ratio baseline
  brewFields: AdaptBrewFields;
  corpus: string; // title + body + rendered brew fields — the grounding source
}

export type AdaptResult =
  | { ok: true; content: string; summary: string }
  | { ok: false; reason: string };

/** Render non-null brew fields into one flat text line of facts the model may use. */
function renderBrewFields(b: AdaptBrewFields): string {
  const parts: string[] = [];
  if (b.method) parts.push(`冲泡方式:${b.method}`);
  if (typeof b.temp === "number") parts.push(`水温:${b.temp}℃`);
  if (b.weight) parts.push(`投茶量:${b.weight}`);
  if (typeof b.steep === "number") parts.push(`耐泡度:${b.steep}泡`);
  return parts.join(" ");
}

/** Pure: derive the adapter input from a normalized note (no network, no DB). */
export function toAdaptSource(note: NormalizedNote): AdaptSource {
  const plainText = extractPlainText(note.content);
  const brewFields: AdaptBrewFields = {
    method: note.brewMethod,
    temp: note.waterTemp,
    weight: note.teaWeight,
    steep: note.steepCount,
  };
  const brew = renderBrewFields(brewFields);
  const corpus = [note.title, plainText, brew].filter(Boolean).join("\n");
  return { title: note.title, plainText, brewFields, corpus };
}

/**
 * Extract maximal arabic-digit runs (years / scores / grams / temps / steep
 * counts). Chinese numerals are intentionally NOT matched — "七克"/"十秒" pass
 * through, to avoid killing legitimate paraphrase. Only specific arabic
 * numbers (the high-risk fabrications: a vintage year, a score) are policed.
 */
export function extractNumberTokens(text: string): string[] {
  return text.match(/[0-9]+/g) ?? [];
}

/**
 * Pure grounding check: every digit run in the adapted text must already be
 * present in the source corpus. Returns {ok:true} when grounded, else
 * {ok:false,reason} naming the first ungrounded token.
 */
export function isGrounded(
  adaptedText: string,
  corpus: string,
): { ok: true } | { ok: false; reason: string } {
  const need = new Set(extractNumberTokens(adaptedText));
  if (need.size === 0) return { ok: true };
  const have = new Set(extractNumberTokens(corpus));
  for (const token of need) {
    if (!have.has(token)) {
      return { ok: false, reason: `ungrounded number: ${token}` };
    }
  }
  return { ok: true };
}

/**
 * Pure length gate: adapted body must stay within [30%, 150%] of source and
 * satisfy an absolute min/max (independent of ratio). The 30% floor lets the
 * model trim a verbose per-steep brew log; the 150% ceiling guards rambling.
 */
export function checkAdaptLength(
  adaptedCodepoints: number,
  sourceCodepoints: number,
): { ok: true } | { ok: false; reason: string } {
  if (adaptedCodepoints < ADAPT_MIN_CODEPOINTS) {
    return { ok: false, reason: `adapted too short: ${adaptedCodepoints}cp` };
  }
  if (adaptedCodepoints > ADAPT_MAX_CODEPOINTS) {
    return { ok: false, reason: `adapted too long: ${adaptedCodepoints}cp` };
  }
  if (sourceCodepoints > 0) {
    const ratio = adaptedCodepoints / sourceCodepoints;
    if (ratio < ADAPT_RATIO_MIN) {
      return {
        ok: false,
        reason: `adapted ${ratio.toFixed(2)}x < ${ADAPT_RATIO_MIN}x of source`,
      };
    }
    if (ratio > ADAPT_RATIO_MAX) {
      return {
        ok: false,
        reason: `adapted ${ratio.toFixed(2)}x > ${ADAPT_RATIO_MAX}x of source`,
      };
    }
  }
  return { ok: true };
}

function buildPrompt(source: AdaptSource): string {
  const brew = renderBrewFields(source.brewFields);
  return [
    '请把下方"源记录"改编成一篇普洱茶论坛帖子。',
    "",
    "【硬性约束】",
    "- 只能使用源记录里已经出现的事实。不得编造年份、产地、价格、评分、冲泡次数、他人评价或源记录未提及的任何细节。",
    "- 简要描述冲泡过程即可,不要逐泡罗列;把篇幅留给口感特点、优点与不足。",
    "- 第一人称、口语化,像一个真人在论坛分享。",
    "- 只能使用这些 HTML 标签:<p> <b> <i> <h2> <ul> <li>。不要使用 <img>、<a>、<script> 或任何属性。",
    "",
    "【源记录】",
    `标题:${source.title}`,
    `正文:${source.plainText || "(无正文)"}`,
    brew ? `参数:${brew}` : "",
    "",
    "【输出格式】",
    "严格返回 JSON 对象(不要 markdown 代码块):",
    '{"content":"正文 HTML","summary":"一句话概括口感结论的摘要(纯文本,30字以内)"}',
    "摘要必须是这篇帖子的核心口感结论,不要重复标题。",
  ]
    .filter(Boolean)
    .join("\n");
}

const ADAPT_SYSTEM =
  "你是普洱茶社区里一位资深的真实茶友。任务:把作者本人的品鉴记录改编成一篇论坛帖子——保留事实、精炼文风,重点写口感、优点和不足。绝不编造源记录里没有的细节。";

interface DeepSeekChoice {
  message?: { content?: string };
}
interface DeepSeekBody {
  choices?: DeepSeekChoice[];
}

/** Best-effort JSON extraction: tolerate surrounding prose or code fences. */
function parseLooseJson(raw: string): { content?: unknown; summary?: unknown } | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { content?: unknown; summary?: unknown };
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as { content?: unknown; summary?: unknown };
    } catch {
      return null;
    }
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Escape + clip the model's plain-text summary to the DB column limit, by codepoint. */
function clipSummary(summary: string): string {
  const escaped = escapeHtml(summary).trim();
  if (codepointLength(escaped) <= SUMMARY_MAX_LENGTH) return escaped;
  return Array.from(escaped).slice(0, SUMMARY_MAX_LENGTH).join("");
}

export interface DeepSeekAdaptOptions {
  source: AdaptSource;
  /** Injectable for tests; defaults to the global fetch. */
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Call DeepSeek to adapt the draft body/summary. Fail-safe: any error or
 * validation failure returns {ok:false,reason} and never throws. On success
 * the returned content has been sanitized, length-checked, and numerically
 * grounded against the source corpus.
 */
export async function deepSeekAdapt(
  opts: DeepSeekAdaptOptions,
): Promise<AdaptResult> {
  const { source } = opts;
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return { ok: false, reason: "DEEPSEEK_API_KEY missing" };

  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? ADAPT_TIMEOUT_MS;

  let resp: Response;
  try {
    resp = await fetcher(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: ADAPT_SYSTEM },
          { role: "user", content: buildPrompt(source) },
        ],
        temperature: ADAPT_TEMPERATURE,
        max_tokens: ADAPT_MAX_TOKENS,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, reason: `fetch error: ${errMsg(e)}` };
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    return { ok: false, reason: `DeepSeek ${resp.status}: ${errText.slice(0, 200)}` };
  }

  let body: DeepSeekBody;
  try {
    body = (await resp.json()) as DeepSeekBody;
  } catch {
    return { ok: false, reason: "DeepSeek returned non-JSON body" };
  }
  const raw = body?.choices?.[0]?.message?.content ?? "";
  const parsed = parseLooseJson(raw);
  if (!parsed) return { ok: false, reason: "no JSON object in model response" };

  const contentHtml = typeof parsed.content === "string" ? parsed.content : "";
  const summaryRaw = typeof parsed.summary === "string" ? parsed.summary : "";
  if (!contentHtml.trim() || !summaryRaw.trim()) {
    return { ok: false, reason: "empty content or summary" };
  }

  // Sanitize model HTML through the SAME gate as the verbatim path, then apply
  // the stricter body whitelist so a misbehaving model cannot leave a link or
  // tracking pixel in the adapted body.
  const sanitized = stripToContentTags(sanitizeNoteHtml(contentHtml));
  if (!sanitized.trim()) return { ok: false, reason: "empty after sanitize" };

  const adaptedPlain = extractPlainText(sanitized);
  const lenCheck = checkAdaptLength(
    codepointLength(adaptedPlain),
    codepointLength(source.plainText),
  );
  if (!lenCheck.ok) return { ok: false, reason: lenCheck.reason };

  // Grounding on body + summary so a fabricated number in either is caught.
  const grounded = isGrounded(`${adaptedPlain} ${summaryRaw}`, source.corpus);
  if (!grounded.ok) return { ok: false, reason: grounded.reason };

  return { ok: true, content: sanitized, summary: clipSummary(summaryRaw) };
}
