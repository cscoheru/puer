/**
 * Tests for source-html.ts (the single HTML parser).
 *
 * Run: node --test --test-reporter=spec src/lib/tea-drafts/source-html.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractParagraphs, extractPlainText, codepointLength } from "./source-html.ts";

test("extractParagraphs: splits <p> blocks in order, strips inline tags", () => {
  const html = "<p>第一段。</p><p>第二段 <strong>加粗</strong>。</p>";
  assert.deepEqual(extractParagraphs(html), ["第一段。", "第二段 加粗。"]);
});

test("extractParagraphs: strips script/style entirely (no script leakage)", () => {
  const html = "<p>可见</p><script>alert(1)</script><style>.x{}</style><p>尾部</p>";
  assert.deepEqual(extractParagraphs(html), ["可见", "尾部"]);
});

test("extractParagraphs: <br> splits a block into separate paragraphs", () => {
  const html = "<p>行一<br>行二</p>";
  assert.deepEqual(extractParagraphs(html), ["行一", "行二"]);
});

test("extractParagraphs: nested blocks do not double-count, stray text kept", () => {
  const html = "<div>导言<p>正文</p></div>";
  assert.deepEqual(extractParagraphs(html), ["导言", "正文"]);
});

test("extractParagraphs: list items become paragraphs", () => {
  const html = "<ul><li>项A</li><li>项B</li></ul>";
  assert.deepEqual(extractParagraphs(html), ["项A", "项B"]);
});

test("extractParagraphs: empty/whitespace-only input yields []", () => {
  assert.deepEqual(extractParagraphs(""), []);
  assert.deepEqual(extractParagraphs("   \n  "), []);
});

test("extractParagraphs: collapses internal whitespace and trims", () => {
  const html = "<p>  多个   空格\t和\t制表  </p>";
  assert.deepEqual(extractParagraphs(html), ["多个 空格 和 制表"]);
});

test("extractPlainText: flattens to one whitespace-collapsed string", () => {
  const html = "<p>foo</p><p>bar</p>";
  assert.equal(extractPlainText(html), "foo bar");
});

test("extractPlainText: strips script/style", () => {
  const html = "<p>x</p><script>secret()</script>";
  assert.equal(extractPlainText(html), "x");
});

test("extractPlainText: empty input → ''", () => {
  assert.equal(extractPlainText(""), "");
});

test("codepointLength: counts code points, not UTF-16 units (emoji = 1)", () => {
  // 🍵 is U+1F375 → 2 UTF-16 code units but 1 code point.
  assert.equal(codepointLength("a🍵b"), 3);
  assert.equal(codepointLength("ab"), 2);
});
