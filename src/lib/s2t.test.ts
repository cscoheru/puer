import { test } from "node:test";
import assert from "node:assert/strict";
import { convertText, convertPostHtml } from "./s2t";

test("convertText: basic SC → TW", () => {
  assert.equal(convertText("推荐"), "推薦");
  assert.equal(convertText("普洱茶论坛"), "普洱茶論壇");
  assert.equal(convertText("熟普"), "熟普"); // identical SC/TW
});

test("convertText: empty / null returns empty string", () => {
  assert.equal(convertText(""), "");
  assert.equal(convertText(null), "");
  assert.equal(convertText(undefined), "");
});

test("convertText: cached call returns same string", () => {
  const a = convertText("推荐");
  const b = convertText("推荐");
  assert.equal(a, b);
  assert.equal(a, "推薦");
});

test("convertPostHtml: converts visible text, preserves tag structure", () => {
  const html = "<p>推荐普洱茶</p>";
  const out = convertPostHtml(html);
  assert.equal(out, "<p>推薦普洱茶</p>");
});

test("convertPostHtml: skips <code> blocks", () => {
  const html = "<p>推荐 <code>使用 brew install</code> 冲泡</p>";
  const out = convertPostHtml(html);
  // <code> inner text stays SC (it's the literal install command)
  assert.match(out, /<code>使用 brew install<\/code>/);
  // visible text outside <code> is converted
  assert.match(out, /<p>推薦 .* 沖泡<\/p>/);
});

test("convertPostHtml: skips <pre> blocks", () => {
  const html = "<pre>推荐 = 推荐词</pre><p>推荐词</p>";
  const out = convertPostHtml(html);
  assert.match(out, /<pre>推荐 = 推荐词<\/pre>/);
  assert.match(out, /<p>推薦詞<\/p>/);
});

test("convertPostHtml: skips <script> and <style>", () => {
  const html = "<style>推荐样式</style><script>var 推荐 = 1;</script><p>推荐</p>";
  const out = convertPostHtml(html);
  assert.match(out, /<style>推荐样式<\/style>/);
  assert.match(out, /<script>var 推荐 = 1;<\/script>/);
  assert.match(out, /<p>推薦<\/p>/);
});

test("convertPostHtml: handles nested tags and text in different branches", () => {
  const html = "<div><span>推荐</span><code>推荐</code><em>收藏价值</em></div>";
  const out = convertPostHtml(html);
  assert.match(out, /<span>推薦<\/span>/);
  assert.match(out, /<code>推荐<\/code>/);
  assert.match(out, /<em>收藏價值<\/em>/);
});

test("convertPostHtml: empty / null returns empty", () => {
  assert.equal(convertPostHtml(""), "");
  assert.equal(convertPostHtml(null), "");
  assert.equal(convertPostHtml(undefined), "");
});

test("convertPostHtml: cached call returns identical string", () => {
  const html = "<p>推荐</p>";
  const a = convertPostHtml(html);
  const b = convertPostHtml(html);
  assert.equal(a, b);
});
