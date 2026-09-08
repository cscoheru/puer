import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeNoteHtml, isSafeUrl, stripToContentTags } from "./sanitize.ts";

test("sanitizeNoteHtml: empty/null input returns empty string", () => {
  assert.equal(sanitizeNoteHtml(""), "");
  assert.equal(sanitizeNoteHtml(null), "");
  assert.equal(sanitizeNoteHtml(undefined), "");
});

test("sanitizeNoteHtml: <script> is removed but surrounding text kept", () => {
  const out = sanitizeNoteHtml(`<p>好茶</p><script>alert(1)</script><p>回甘</p>`);
  assert.equal(out, "<p>好茶</p><p>回甘</p>");
});

test("sanitizeNoteHtml: event-handler attributes are stripped", () => {
  const out = sanitizeNoteHtml(`<img src="/uploads/x.jpg" onerror="alert(1)" onload="evil()">`);
  assert.ok(!out.includes("onerror"), "onerror must be removed");
  assert.ok(!out.includes("onload"), "onload must be removed");
  assert.ok(out.includes("/uploads/x.jpg"), "safe src preserved");
});

test("sanitizeNoteHtml: javascript:/vbscript:/data: URLs are stripped from href", () => {
  const out = sanitizeNoteHtml(
    `<a href="javascript:alert(1)">a</a><a href="vbscript:x">b</a><a href="data:text/html,<script>">c</a>`,
  );
  assert.ok(!out.includes("javascript:"), "javascript: must be removed");
  assert.ok(!out.includes("vbscript:"), "vbscript: must be removed");
  assert.ok(!out.includes("data:"), "data: must be removed");
});

test("sanitizeNoteHtml: safe http(s)/relative/mailto/fragment URLs survive", () => {
  const out = sanitizeNoteHtml(
    `<a href="https://example.com/p">1</a><a href="/uploads/forum/a.jpg">2</a><a href="mailto:t@t.io">3</a><a href="#sec">4</a>`,
  );
  assert.ok(out.includes('href="https://example.com/p"'));
  assert.ok(out.includes('href="/uploads/forum/a.jpg"'));
  assert.ok(out.includes('href="mailto:t@t.io"'));
  assert.ok(out.includes('href="#sec"'));
});

test("sanitizeNoteHtml: inline style attributes are stripped (CSS vectors)", () => {
  const out = sanitizeNoteHtml(`<p style="background:url(javascript:alert(1))">hi</p>`);
  assert.ok(!out.includes("style"), "style attribute must be removed");
  assert.ok(out.includes("hi"), "text content kept");
});

test("sanitizeNoteHtml: dangerous nested elements removed", () => {
  const out = sanitizeNoteHtml(`<p>ok</p><iframe srcdoc="<script>"></iframe><svg/onload=alert(1)>`);
  assert.ok(!out.includes("<iframe"), "iframe must be removed");
  assert.ok(!out.includes("onload"), "svg onload must be removed");
  assert.ok(out.includes("<p>ok</p>"), "paragraph kept");
});

test("sanitizeNoteHtml: control chars in URL defeat sanitization attempt", () => {
  // "java\tscript:" — tab inside scheme to bypass a naive regex.
  const out = sanitizeNoteHtml(`<a href="java\tscript:alert(1)">x</a>`);
  assert.ok(!out.includes("script"), "control-char-obfuscated scheme must be removed");
});

test("sanitizeNoteHtml: keeps ordinary formatting tags", () => {
  const src = `<h2>冲泡</h2><ul><li>5g</li></ul><p><strong>浓郁</strong> <em>花香</em></p>`;
  assert.equal(sanitizeNoteHtml(src), src);
});

test("isSafeUrl: rejects dangerous schemes and control chars", () => {
  assert.equal(isSafeUrl("javascript:alert(1)"), false);
  assert.equal(isSafeUrl("DATA:text/html,x"), false);
  assert.equal(isSafeUrl("vbscript:x"), false);
  assert.equal(isSafeUrl("java\tscript:x"), false);
  assert.equal(isSafeUrl(""), false);
  assert.equal(isSafeUrl(123), false);
  assert.equal(isSafeUrl(undefined), false);
});

test("isSafeUrl: accepts safe URLs", () => {
  assert.equal(isSafeUrl("https://example.com"), true);
  assert.equal(isSafeUrl("http://localhost:3000/a"), true);
  assert.equal(isSafeUrl("/uploads/forum/a.jpg"), true);
  assert.equal(isSafeUrl("mailto:t@t.io"), true);
  assert.equal(isSafeUrl("#fragment"), true);
});

// ─── stripToContentTags (model-adapted body whitelist) ──────────────────

test("stripToContentTags: empty/null input returns empty string", () => {
  assert.equal(stripToContentTags(""), "");
  assert.equal(stripToContentTags(null), "");
  assert.equal(stripToContentTags(undefined), "");
});

test("stripToContentTags: <a> unwrapped, anchor text kept, href gone", () => {
  const out = stripToContentTags(`<p>好茶<a href="https://spam.example/buy">详情</a></p>`);
  assert.equal(out, `<p>好茶详情</p>`);
});

test("stripToContentTags: <img> tracking pixel removed entirely", () => {
  const out = stripToContentTags(`<p>x</p><img src="https://t.example/pixel.png">`);
  assert.ok(!out.includes("<img"), "no <img> in output");
  assert.ok(!out.includes("t.example"), "tracker host gone");
  assert.equal(out, `<p>x</p>`);
});

test("stripToContentTags: all attributes stripped from kept tags", () => {
  const out = stripToContentTags(`<p class="lead" style="color:red" data-x="1">hi</p>`);
  assert.equal(out, `<p>hi</p>`);
});

test("stripToContentTags: allowed formatting tags survive unchanged", () => {
  const src = `<h2>冲泡</h2><p><b>浓</b> <i>花香</i></p><ul><li>5g</li></ul>`;
  assert.equal(stripToContentTags(src), src);
});

test("stripToContentTags: disallowed containers unwrapped, children preserved", () => {
  const out = stripToContentTags(`<div class="x"><span>前</span><p>正</p></div>`);
  assert.equal(out, `前<p>正</p>`);
});

test("stripToContentTags: empty <a> with no anchor text disappears cleanly", () => {
  const out = stripToContentTags(`<p>a</p><a href="https://x.example"></a>`);
  assert.equal(out, `<p>a</p>`);
});

test("stripToContentTags: nested disallowed unwrapped without losing text", () => {
  const out = stripToContentTags(`<div><div><p>核心</p></div></div>`);
  assert.equal(out, `<p>核心</p>`);
});
