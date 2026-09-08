/**
 * Untrusted-HTML → plain-text extraction for tasting-note content.
 *
 * The ONLY place that parses note `content`. Every other module treats note
 * content as opaque; they ask this module for "the ordered paragraphs" or
 * "the flat safe text". This concentrates all HTML-parsing risk in one spot.
 *
 * Why cheerio (the single new prod dependency this feature adds): Node has no
 * DOMParser, and parsing HTML with regex is unreliable. cheerio is used ONLY
 * on the user's own tasting-note body — never on a remote page.
 *
 * Determinism contract: same HTML in → same paragraph list out, always. No
 * network, no clock, no model. Safe to run under `node --test`.
 *
 * Paragraph extraction strategy: we prepend a "\n" INSIDE every block-level
 * element before reading the body text. This marks block boundaries exactly
 * once per block (nesting does not double-count) and preserves stray text
 * that sits between child blocks — e.g. `<div>intro<p>x</p></div>` yields
 * ["intro","x"], not ["x"]. `<br>` is also turned into a newline. After
 * stripping tags, we split on newlines and trim each line.
 */
import * as cheerio from "cheerio";

/** Block-level selectors whose start marks a paragraph boundary. */
const BLOCK_SELECTOR =
  "p,div,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,tr,section,article,header,footer,pre,dt,dd";

/**
 * Load HTML, strip dangerous nodes, and mark block/`<br>` boundaries with a
 * newline. Shared by `extractParagraphs` (keeps the newlines as splits) and
 * `extractPlainText` (collapses them to spaces) so the two views agree on
 * where one block ends and the next begins.
 */
function loadWithBoundaries(html: string): string {
  const $ = cheerio.load(html);
  $("script,style,noscript").remove();
  $(BLOCK_SELECTOR).prepend("\n");
  $("br").replaceWith("\n");
  return $("body").text() || $.root().text();
}

/**
 * Extract ordered, non-empty, plain-text paragraphs from untrusted HTML.
 * Tags are stripped; inline formatting is flattened to text; block structure
 * becomes paragraph boundaries.
 */
export function extractParagraphs(html: string): string[] {
  if (!html) return [];
  const paragraphs: string[] = [];
  for (const line of loadWithBoundaries(html).split("\n")) {
    // `\s` already matches U+00A0, so nbsp collapses with other whitespace.
    const t = line.replace(/\s+/g, " ").trim();
    if (t) paragraphs.push(t);
  }
  return paragraphs;
}

/**
 * Extract a single flat, whitespace-collapsed plain-text string. Block
 * boundaries become single spaces (not dropped), so the code-point length is
 * faithful. Used by hard-gates for the "≥ N Unicode code points of safe text"
 * length check.
 */
export function extractPlainText(html: string): string {
  if (!html) return "";
  return loadWithBoundaries(html).replace(/\s+/g, " ").trim();
}

/** Length in Unicode code points (surrogate pairs count as one). */
export function codepointLength(s: string): number {
  return [...s].length;
}
