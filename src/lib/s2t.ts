/**
 * Simplified Chinese → Traditional Chinese (Taiwan Standard) conversion.
 *
 * Server-only. Used by `/tw/...` pages to mirror user content for TW/HK/MO
 * visitors. Cached by content hash; HTML conversion walks the DOM with cheerio
 * and skips code-like ancestors where character identity must be preserved.
 */
// Server-only guard: throws if loaded in a browser bundle. Equivalent to the
// `server-only` package's behavior in Next.js bundling, but works under
// `node --test` too (the npm `server-only` package throws unconditionally).
if (typeof window !== "undefined") {
  throw new Error("s2t is a server-only module");
}
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
// opencc-js exports a CommonJS namespace; default ESM interop yields the namespace.
// The Converter factory is the only export we use.
import * as OpenCC from "opencc-js";

const converter = OpenCC.Converter({ from: "cn", to: "tw" });

const SKIP_ANCESTORS = new Set([
  "script",
  "style",
  "code",
  "pre",
  "kbd",
  "samp",
  "var",
  "noscript",
  "template",
  "textarea",
]);

// Two caches, not one. `convertText` is called with short, high-churn strings
// (every label, title and metadata field on every render) while
// `convertPostHtml` is called with whole articles — one entry can be hundreds of
// kilobytes. Sharing a single 500-entry FIFO meant a burst of label lookups
// could evict every cached article body, and one long article could evict most
// of the labels; both paths then re-ran opencc + cheerio at full cost. Splitting
// them gives each path a budget sized to its own entry cost.
const MAX_TEXT_CACHE = 500;
const MAX_HTML_CACHE = 100;
const textCache = new Map<string, string>();
const htmlCache = new Map<string, string>();

function key(input: string): string {
  return createHash("sha256").update("s2tw:").update(input).digest("hex").slice(0, 32);
}

/** FIFO eviction (Map preserves insertion order). */
function store(cache: Map<string, string>, k: string, value: string, max: number): string {
  if (cache.size >= max) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(k, value);
  return value;
}

/** Plain-text conversion. Use for metadata title/description and JSON-LD fields. */
export function convertText(input: string | null | undefined): string {
  if (input == null) return "";
  const s = String(input);
  if (!s) return "";
  const k = key(s);
  const hit = textCache.get(k);
  if (hit !== undefined) return hit;
  return store(textCache, k, converter(s), MAX_TEXT_CACHE);
}

/** HTML conversion. Walks the DOM and converts text nodes only when none of
 *  their ancestors are in SKIP_ANCESTORS. Returns the converted HTML string
 *  ready to be passed to a sanitizer / renderer. */
export function convertPostHtml(html: string | null | undefined): string {
  if (html == null) return "";
  const h = String(html);
  if (!h) return "";
  const k = key(h);
  const hit = htmlCache.get(k);
  if (hit !== undefined) return hit;

  // Wrap in a sentinel root so we can recover the original fragment even when
  // it starts with a text node (cheerio requires a single root).
  const $ = cheerio.load(`<div id="__root">${h}</div>`, { xml: false });
  const root = $("#__root").get(0);
  walk(root);

  // Serialize back. cheerio's `.html()` may re-encode some entities; this is
  // safe for our downstream consumer (ForumContent via dangerouslySetInnerHTML
  // goes through sanitizeHtml which normalizes anyway).
  return store(htmlCache, k, $("#__root").html() ?? "", MAX_HTML_CACHE);
}

type AnyNode = {
  type?: string;
  name?: string;
  data?: string;
  children?: AnyNode[];
  parent?: AnyNode | null;
};

function walk(node: AnyNode | null | undefined): void {
  if (!node) return;
  if (node.type === "text") {
    if (!isInsideSkip(node)) {
      node.data = converter(node.data ?? "");
    }
    return;
  }
  if (node.type === "comment" || node.type === "directive") return;
  if (!node.children) return;
  for (const child of node.children) walk(child);
}

function isInsideSkip(textNode: AnyNode): boolean {
  let p = textNode.parent ?? null;
  while (p) {
    const tag = (p.name || "").toLowerCase();
    if (tag === "#root" || tag === "__root") return false;
    if (SKIP_ANCESTORS.has(tag)) return true;
    p = p.parent ?? null;
  }
  return false;
}
