/**
 * sanitize.ts — server-side HTML sanitizer for untrusted note content.
 *
 * The draft-review panel shows the author's original TastingNote next to the
 * assembled draft so a reviewer can confirm provenance. That note `content`
 * is untrusted author HTML, so it must not reach the client raw. This module
 * is the trust boundary: `/api/drafts` GET runs note content through
 * `sanitizeNoteHtml` before returning it; the client then renders the already
 * safe HTML.
 *
 * Uses cheerio (already a prod dep, already used by `source-html.ts` for the
 * same data) rather than rehype-sanitize, which would need two extra declared
 * deps (rehype-parse / rehype-stringify) to parse and stringify HTML. Server-
 * side only — never import this from a client component (cheerio is heavy).
 */

import * as cheerio from "cheerio";

// Elements removed entirely: they execute script, fetch external content, or
// carry scriptable foreign content. Media in note content is surfaced via the
// structured images/videoUrl fields, so <video>/<audio>/<source> are stripped
// from the raw HTML view rather than trusted.
const REMOVE_TAGS =
  "script,style,iframe,object,embed,applet,link,meta,base,title,noscript,template," +
  "svg,math,form,input,button,textarea,select,option,optgroup,label,fieldset,legend," +
  "frame,frameset,audio,video,source,track,portal";

// Attributes that load a URL. Their values must survive `isSafeUrl`.
const URL_ATTRS = new Set([
  "href", "src", "xlink:href", "poster", "cite", "data", "action", "formaction", "background",
]);

// Schemes that execute or load dangerous content. Site-relative paths
// ("/uploads/...") and http(s)/mailto/fragments are not matched here and pass.
const DANGEROUS_SCHEME = /^\s*(javascript|vbscript|file|data|about|mocha|livescript)\s*:/i;
// Control characters (tab, newline, NUL, …) inside a URL can defeat scheme
// detection in some browsers; reject any as a hardening backstop.
const CONTROL_CHAR = /[\x00-\x1f\x7f]/;

export function isSafeUrl(val: unknown): boolean {
  if (typeof val !== "string") return false;
  const v = val.trim();
  if (!v) return false;
  if (DANGEROUS_SCHEME.test(v)) return false;
  if (CONTROL_CHAR.test(v)) return false;
  return true;
}

/**
 * Sanitize untrusted HTML to a safe subset for display. Strips dangerous
 * elements/attributes but keeps ordinary formatting (paragraphs, headings,
 * lists, emphasis, links, images) so the reviewer still reads prose.
 */
export function sanitizeNoteHtml(html: string | null | undefined): string {
  if (!html) return "";
  const $ = cheerio.load(html);
  $(REMOVE_TAGS).remove();
  $("*").each((_, el) => {
    // Element nodes only; cheerio gives text/comment nodes type !== "tag".
    if (el.type !== "tag" || !el.attribs) return;
    for (const name of Object.keys(el.attribs)) {
      const lc = name.toLowerCase();
      // Drop all event handlers and inline styles (CSS-based vectors).
      if (lc.startsWith("on") || lc === "style") {
        delete el.attribs[name];
      } else if (URL_ATTRS.has(lc)) {
        if (!isSafeUrl(el.attribs[name])) delete el.attribs[name];
      }
    }
  });
  return $("body").html() ?? "";
}

// Tags permitted in a model-adapted post body. Matches the adapter prompt's
// allowed set (p/b/i/h2/ul/li) plus harmless text-level equivalents — strong/em
// are just b/i, ol is just ul, br is a void line break. Every other tag is
// unwrapped and every attribute is dropped, so adapted HTML can never carry a
// URL, a tracking pixel, or an event handler. Run AFTER sanitizeNoteHtml: that
// pass must first .remove() script/iframe/style entirely (unwrapping them would
// spill their text into the page).
const BODY_TAGS = new Set([
  "p", "b", "i", "strong", "em", "h2", "ul", "ol", "li", "br",
]);

/**
 * Stricter pass for model-adapted body HTML. Keeps only `BODY_TAGS`, drops
 * every attribute, and replaces any other element with its own children (so
 * inner text survives, while <img> — which has no children — vanishes). Unlike
 * sanitizeNoteHtml (a presentation sanitizer that legitimately keeps <a>/<img>
 * for note review), this enforces the adapter's "no links, no images, no
 * attributes" contract at the code level: a model that ignores the prompt still
 * cannot smuggle in a spam link or tracking pixel.
 */
export function stripToContentTags(html: string | null | undefined): string {
  if (!html) return "";
  const $ = cheerio.load(html);
  // Scope to $("body *") so the html/head/body wrappers cheerio synthesizes for
  // a fragment are never matched — unwrapping <body> itself detaches the content
  // and makes body.html() return null. Unwrap each non-whitelisted descendant:
  // move its children out with .before(contents), then drop the empty wrapper.
  // .before + .remove (not replaceWith) is the robust idiom for unwrapping a
  // node that owns its own descendants in this cheerio version.
  $("body *").each((_, el) => {
    if (el.type !== "tag") return;
    if (BODY_TAGS.has(el.name.toLowerCase())) return;
    const $el = $(el);
    $el.before($el.contents());
    $el.remove();
  });
  // Strip every remaining attribute — the body model carries none.
  $("body *").each((_, el) => {
    if (el.type !== "tag" || !el.attribs) return;
    el.attribs = {};
  });
  return $("body").html() ?? "";
}
