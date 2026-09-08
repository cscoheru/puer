/**
 * Safety tests for `safeJsonLdStringify`.
 *
 * `JSON.stringify` alone is unsafe inside a <script> block: `<`, `>`, `&` can
 * break out of the element, and U+2028 / U+2029 terminate JS string literals
 * in some engines. These tests PROVE every dangerous character is escaped to a
 * `\uXXXX` sequence, that the output never contains a literal `</script>`, and
 * that escaping is lossless (`JSON.parse` round-trips back to the input).
 *
 * U+2028 / U+2029 are built from code points so this file stays pure ASCII.
 *
 * Run: node --test --test-reporter=spec src/lib/json-ld.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeJsonLdStringify } from "./json-ld.ts";

const LS = String.fromCharCode(0x2028); // LINE SEPARATOR
const PS = String.fromCharCode(0x2029); // PARAGRAPH SEPARATOR

test("escapes < > & to \\uXXXX", () => {
  const out = safeJsonLdStringify("a<b>c&d");
  assert.equal(out, '"a\\u003cb\\u003ec\\u0026d"');
  assert.ok(!out.includes("<"), "output must not contain a literal <");
  assert.ok(!out.includes(">"), "output must not contain a literal >");
  assert.ok(!out.includes("&"), "output must not contain a literal &");
});

test("a literal </script> in content cannot close the script element", () => {
  const out = safeJsonLdStringify({ html: "</script><script>alert(1)</script>" });
  assert.ok(!out.includes("</script>"), "output must not contain literal </script>");
  assert.ok(!out.includes("<script"), "output must not contain an opening <script");
});

test("escapes U+2028 and U+2029 line separators", () => {
  const out = safeJsonLdStringify(`line1${LS}line2${PS}line3`);
  assert.ok(!out.includes(LS), "output must not contain a literal U+2028");
  assert.ok(!out.includes(PS), "output must not contain a literal U+2029");
  assert.ok(out.includes("\\u2028"), "output must contain the \\u2028 escape");
  assert.ok(out.includes("\\u2029"), "output must contain the \\u2029 escape");
});

test("escaping is lossless: JSON.parse round-trips every escaped value", () => {
  const inputs = [
    "plain text",
    "a<b>c&d",
    `multi${LS}line${PS}end`,
    { nested: { deep: "<>&" + LS + PS } },
    ["</script>", "x", 42, null, true, false],
    { "@type": "Article", headline: "普洱 <生茶> & 熟茶" },
    "",
  ];
  for (const input of inputs) {
    const out = safeJsonLdStringify(input);
    assert.deepEqual(JSON.parse(out), input, `round-trip failed for ${JSON.stringify(input)}`);
  }
});

test("handles primitives and null without throwing", () => {
  assert.equal(safeJsonLdStringify(null), "null");
  assert.equal(safeJsonLdStringify(42), "42");
  assert.equal(safeJsonLdStringify(true), "true");
  assert.equal(safeJsonLdStringify("no danger"), '"no danger"');
});

test("nested object with all dangerous chars in every string field", () => {
  const out = safeJsonLdStringify({
    a: "<a>",
    b: ["&b", `c${LS}d`],
    c: { d: `</script>${PS}` },
  });
  for (const ch of ["<", ">", "&", LS, PS]) {
    assert.ok(!out.includes(ch), `output must not contain literal ${JSON.stringify(ch)}`);
  }
  // Still valid JSON that decodes back to the original structure.
  assert.deepEqual(JSON.parse(out), {
    a: "<a>",
    b: ["&b", `c${LS}d`],
    c: { d: `</script>${PS}` },
  });
});
