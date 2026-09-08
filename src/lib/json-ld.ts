/**
 * Safe serialization for JSON-LD <script type="application/ld+json"> blocks.
 *
 * `JSON.stringify` alone is NOT safe to interpolate into an HTML <script>: the
 * characters `<`, `>`, `&` can close or open tags, and U+2028 / U+2029 (LINE /
 * PARAGRAPH SEPARATOR) are valid in JSON but terminate JS string literals in
 * some engines. This escapes all of them so the result is safe to place into
 * `dangerouslySetInnerHTML` without breaking out of the script element or the
 * surrounding markup (design doc §Security and Trust Boundaries).
 *
 * This hardens the serialization boundary only. It must wrap a value you have
 * assembled yourself; it does not make untrusted input safe to embed.
 *
 * Implementation note: targets and replacements are built from code points so
 * the source contains only ASCII. U+2028 / U+2029 are JS line terminators, so a
 * regex literal containing them would be a syntax error; `split`/`join` over
 * `String.fromCharCode` sidesteps that entirely.
 */
export function safeJsonLdStringify(value: unknown): string {
  // Replacement text is the literal JS unicode escape (backslash + "u" + hex),
  // so the emitted JSON still decodes to the original character.
  const escape = (codePoint: number): string =>
    String.fromCharCode(0x5c) + "u" + codePoint.toString(16).padStart(4, "0");

  let out = JSON.stringify(value);
  for (const cp of [0x3c, 0x3e, 0x26, 0x2028, 0x2029]) {
    out = out.split(String.fromCharCode(cp)).join(escape(cp));
  }
  return out;
}
