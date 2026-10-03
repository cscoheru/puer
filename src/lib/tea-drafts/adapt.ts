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
 *   2. Length bounds vs source (20%–200%) + absolute min/max.
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
import {
  extractParagraphs,
  extractPlainText,
  codepointLength,
} from "./source-html.ts";
import { sanitizeNoteHtml, stripToContentTags } from "./sanitize.ts";
import { escapeHtml, SUMMARY_MAX_LENGTH } from "./assemble.ts";
import type { NormalizedNote } from "./normalize.ts";
import { styleByKey, type StyleKey, type TeaDraftStyle } from "./styles.ts";

// DeepSeek config — mirrors src/lib/moderation.ts. Those consts are
// module-private there, so they are re-declared here to keep the adapter free
// of a runtime dependency on the moderation module's side effects.
const MINIMAX_URL = "https://api.minimax.cn/v1/chat/completions";
const MINIMAX_MODEL = "MiniMax-M3";

// Adaptation knobs. The ratio band was 0.3–1.5 and is now 0.2–2.0: the prompt
// explicitly tells the model to DISCARD the reference/provenance material that
// real notes are made of (product history, market talk, batch lore) and write
// only the author's own tasting facts, so a correct rewrite of a 资料-heavy note
// is legitimately much shorter than the source — and a rewrite that turns a thin
// one-liner into a proper post is legitimately longer. Widening the ratio is a
// style constraint relaxation only; the fact constraints (numeric grounding,
// HTML whitelist) below are untouched.
const ADAPT_TIMEOUT_MS = 30_000;
const ADAPT_TEMPERATURE = 0.4;
const ADAPT_MAX_TOKENS = 2000;
const ADAPT_MIN_CODEPOINTS = 60;
const ADAPT_MAX_CODEPOINTS = 2000; // hard ceiling independent of ratio
const ADAPT_RATIO_MIN = 0.2;
const ADAPT_RATIO_MAX = 2.0;

/**
 * How many times the model is sampled before the rewrite is given up on.
 *
 * Measured, not guessed: 11 production calls on one 1600cp note failed 3 times
 * — one timeout at the old 20s ceiling (normal latency is 9–18s, so the old
 * timeout sat barely above the median), one completion truncated at the old
 * 800-token cap (`finish_reason: "length"`), and one response whose JSON was
 * malformed mid-body. Sampling at temperature 0.4 is not reproducible, so a
 * transient miss is not a deterministic verdict on the note.
 *
 * The pipeline fails closed — a failed adapt leaves the verbatim draft standing
 * — so a retry cannot corrupt anything. It only buys back the rewrite the user
 * asked for, at the price of one extra call on an already-failing path. Two
 * attempts takes a ~27% miss rate down to the square of it.
 */
const ADAPT_ATTEMPTS = 2;

export interface AdaptBrewFields {
  method: string | null;
  temp: number | null;
  weight: string | null;
  steep: number | null;
}

/** Everything the adapter needs, derived purely from a normalized note. */
export interface AdaptSource {
  title: string;
  /**
   * The tea product name — i.e. the title the finished article will actually
   * carry (see `assemble.ts`'s `assembleTitle`). Distinct from `title`, which is
   * the note's own diary log line ("2026开汤第3场"). The model needs both: the
   * product name to write about the right tea, the note title for context. It
   * is also part of `corpus` — see `toAdaptSource` for why.
   */
  teaName: string | null;
  plainText: string; // HTML-stripped body: prompt input + length-ratio baseline
  brewFields: AdaptBrewFields;
  corpus: string; // tea name + title + body + rendered brew fields — the grounding source
}

/**
 * On success, `style` is the voice the rewrite was actually performed in —
 * echoed back so the caller can persist it next to the text without recomputing
 * the hash and risking a mismatch. On failure there is no style, because no
 * rewrite happened.
 */
export type AdaptResult =
  | { ok: true; content: string; summary: string; style: StyleKey }
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

/**
 * Reference/provenance material, identified by a leading bracketed 资料 marker —
 * the marker may carry a qualifier inside the brackets (「（资料）」, 「（资料4）」).
 * Census of the 1686 production notes found this only ever on TITLES (112 of
 * them: 108 bare 「（资料）」 + 4 numbered), never in a body paragraph — so this is
 * a cheap defensive net for future imports, not a fix for live data. The real
 * 资料 problem is semantic (bodies
 * mix reference prose with the author's own tasting facts) and is handled by the
 * prompt's A/B separation instruction below.
 */
const REFERENCE_PARAGRAPH = /^[（(【\[]\s*资料[^）)】\]]*[）)】\]]/;

/**
 * The prefix form of {@link REFERENCE_PARAGRAPH} for Prisma's `startsWith`,
 * used by the selection filter in `runner.ts`. One rule, two stages:
 * selection drops whole reference notes, this module drops reference paragraphs
 * inside a kept one. Prisma cannot take a regex, so selection gets the widest
 * safe prefix of the pattern above — conservative by construction: it can only
 * over-exclude (a hypothetical 「（资料室）的老茶局」 would be dropped), never
 * under-exclude. Under-exclusion is what let 「（资料4）论冰岛老寨茶」 become the
 * top-ranked candidate and get rewritten into a post, which is the exact thing
 * the user asked us to stop doing.
 */
export const REFERENCE_TITLE_PREFIX = "（资料";

/** Pure: drop paragraphs that open with a reference marker. Order preserved. */
export function dropReferenceParagraphs(paragraphs: readonly string[]): string[] {
  return paragraphs.filter((p) => !REFERENCE_PARAGRAPH.test(p));
}

/**
 * Pure: derive the adapter input from a normalized note (no network, no DB).
 *
 * The reference-paragraph filter is applied here, on purpose, to ALL THREE
 * fields the adapter reasons over — prompt input, length baseline, grounding
 * corpus. They have to agree: a fact the model is told not to use must not be
 * sitting in the corpus that licenses numbers, and material the prompt discards
 * must not inflate the baseline the rewrite's length is judged against (which
 * is exactly the 资料-heavy case the 0.2 ratio floor exists for).
 */
export function toAdaptSource(note: NormalizedNote): AdaptSource {
  const paragraphs = dropReferenceParagraphs(extractParagraphs(note.content));
  const plainText = paragraphs.join(" ");
  const brewFields: AdaptBrewFields = {
    method: note.brewMethod,
    temp: note.waterTemp,
    weight: note.teaWeight,
    steep: note.steepCount,
  };
  const brew = renderBrewFields(brewFields);
  const teaName = (note.teaName ?? "").trim() || null;
  // The tea name joins the corpus as a first-class source fact. It has to:
  // product names carry digits (「97老树圆茶」, 「7542」), and once the model is
  // told the article's title is that name it will write it into the body — if
  // the name were outside the corpus, `isGrounded` would reject the output for
  // stating the article's own title. Content we ask the model to write must be
  // licensed by the same corpus that polices it.
  const corpus = [teaName, note.title, plainText, brew].filter(Boolean).join("\n");
  return { title: note.title, teaName, plainText, brewFields, corpus };
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
 * Pure length gate: adapted body must stay within [20%, 200%] of source and
 * satisfy an absolute min/max (independent of ratio). The floor lets the model
 * cut a 资料-heavy note down to its tasting facts; the ceiling guards rambling.
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

function buildPrompt(source: AdaptSource, style: TeaDraftStyle): string {
  const brew = renderBrewFields(source.brewFields);
  return [
    '请把下方"源记录"改编成一篇普洱茶论坛帖子。',
    "",
    "【先分清两类内容】",
    "笔记正文通常把两类内容混在一起,改写前先在心里分开:",
    "A. 资料性内容 —— 产品沿革、市场说法、行情价、批次知识、历史考据、转述的他人记录。",
    "B. 作者本人的品鉴事实 —— 这次开汤的冲泡、逐泡感受、香气/汤色/口感/回甘、优点与不足、本人的判断。",
    "只写 B。A 一律丢弃:不要转述、不要概括、不要「顺带提一句」,不要写成产品介绍或历史考据。",
    "",
    "【硬性约束】",
    "- 只能使用源记录里已经出现的事实。不得编造年份、产地、价格、评分、冲泡次数、他人评价或源记录未提及的任何细节。",
    "- 简要描述冲泡过程即可,不要逐泡罗列;把篇幅留给口感特点、优点与不足。",
    "- 第一人称、口语化,像一个真人在论坛分享。",
    "- 只能使用这些 HTML 标签:<p> <b> <i> <h2> <ul> <li>。不要使用 <img>、<a>、<script> 或任何属性。",
    "",
    `【文风】${style.label}`,
    style.voice,
    "",
    "【源记录】",
    source.teaName ? `茶品:${source.teaName}` : "",
    `笔记标题:${source.title}`,
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
  "你是普洱茶社区里一位资深的真实茶友。任务:把作者本人的品鉴记录改编成一篇论坛帖子——只保留作者亲口写的品鉴事实,把产品资料、市场行情、历史考据全部剔除,再按指定文风重新组织。绝不编造源记录里没有的细节。";

interface DeepSeekChoice {
  message?: { content?: string };
  /**
   * Kept and surfaced in failure reasons only — never used to accept output.
   * `"length"` is the tell for a completion cut off at ADAPT_MAX_TOKENS, which
   * presents as an unparseable JSON blob and would otherwise be reported as
   * the useless symptom "no JSON object in model response".
   */
  finish_reason?: string;
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
  /**
   * Required, not optional: the caller resolves it from the note id
   * (`styleFor`). Deliberately no default — an omitted style must fail loudly
   * rather than silently rewrite everything in one voice.
   */
  style: StyleKey;
  /** Injectable for tests; defaults to the global fetch. */
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

/**
 * One sample of the model. Extracted from `deepSeekAdapt` so it can be retried:
 * every failure mode below is either transient (transport) or sampling-dependent
 * (the model's JSON), and the caller has no reason to care which attempt landed.
 * Same fail-safe contract as the public entry point — returns, never throws.
 */
async function runAdaptAttempt(
  opts: DeepSeekAdaptOptions,
  style: TeaDraftStyle,
  key: string,
): Promise<AdaptResult> {
  const { source } = opts;
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? ADAPT_TIMEOUT_MS;

  let resp: Response;
  try {
    resp = await fetcher(MINIMAX_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        messages: [
          { role: "system", content: ADAPT_SYSTEM },
          { role: "user", content: buildPrompt(source, style) },
        ],
        temperature: ADAPT_TEMPERATURE,
        max_completion_tokens: ADAPT_MAX_TOKENS,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, reason: `fetch error: ${errMsg(e)}` };
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    return { ok: false, reason: `MiniMax ${resp.status}: ${errText.slice(0, 200)}` };
  }

  let body: DeepSeekBody;
  try {
    body = (await resp.json()) as DeepSeekBody;
  } catch {
    return { ok: false, reason: "MiniMax returned non-JSON body" };
  }
  const choice = body?.choices?.[0];
  const raw = choice?.message?.content ?? "";
  const finish = choice?.finish_reason;
  const parsed = parseLooseJson(raw);
  if (!parsed) {
    // Name the cause, not the symptom. "no JSON object" alone cannot tell a
    // size problem (fix ADAPT_MAX_TOKENS) from a model that put the payload
    // somewhere other than `message.content` (fix the prompt or the field) —
    // both were seen in production and need different treatment.
    const detail =
      finish === "length"
        ? "truncated at max_completion_tokens"
        : !raw
          ? "empty model content"
          : "unparseable model JSON";
    return {
      ok: false,
      reason: `no JSON object in model response (${detail}, finish=${finish ?? "?"})`,
    };
  }

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

  return {
    ok: true,
    content: sanitized,
    summary: clipSummary(summaryRaw),
    style: style.key,
  };
}

/**
 * Call MiniMax (OpenAI-compatible) to adapt the draft body/summary. Fail-safe:
 * any error or validation failure returns {ok:false,reason} and never throws.
 * On success the returned content has been sanitized, length-checked, and
 * numerically grounded against the source corpus.
 *
 * Samples the model up to {@link ADAPT_ATTEMPTS} times; the reason reported on
 * failure is the last one, tagged with the attempt count so a log line still
 * reads as "this was retried and still failed" rather than a single blip.
 *
 * P2-R25:DeepSeek → MiniMax 切换。函数名 deepSeekAdapt 为历史名,被
 * runner/测试引用,暂保留;内部已走 MINIMAX_API_KEY + MiniMax-M3。
 */
export async function deepSeekAdapt(
  opts: DeepSeekAdaptOptions,
): Promise<AdaptResult> {
  const style = styleByKey(opts.style);
  if (!style) return { ok: false, reason: `unknown style: ${opts.style}` };
  const key = process.env.MINIMAX_API_KEY;
  if (!key) return { ok: false, reason: "MINIMAX_API_KEY missing" };

  let last: AdaptResult = { ok: false, reason: "no attempt ran" };
  for (let attempt = 1; attempt <= ADAPT_ATTEMPTS; attempt++) {
    last = await runAdaptAttempt(opts, style, key);
    if (last.ok) return last;
  }
  return {
    ok: false,
    reason: `${last.reason} (after ${ADAPT_ATTEMPTS} attempts)`,
  };
}
