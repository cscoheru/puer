/**
 * 渲染层 HTML 消毒（src/lib/sanitize.ts）—— 帖子/评论/后台内容共用这一道。
 *
 * 2026-11-06：「AI 创作」接入发帖正文时实测发现两个可绕过的载荷
 * （<style> 包 <img/src=x/onerror=…>、`/` 当属性分隔符），补了成对删除
 * 与分隔符边界之后钉在这里，避免以后改正则时回退。
 *
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeHtml } from "./sanitize.ts";

test("sanitizeHtml: 空值与非字符串返回空串", () => {
  assert.equal(sanitizeHtml(""), "");
  assert.equal(sanitizeHtml(null as unknown as string), "");
  assert.equal(sanitizeHtml(undefined as unknown as string), "");
});

test("sanitizeHtml: 保留普通富文本", () => {
  const src = `<p>好茶</p><h2>冲泡</h2><b>浓</b><a href="https://puer.im/x">链接</a>`;
  assert.equal(sanitizeHtml(src), src);
});

test("sanitizeHtml: <script> 连内容一起删除", () => {
  const out = sanitizeHtml(`<p>好茶</p><script>alert(1)</script><p>回甘</p>`);
  assert.equal(out, `<p>好茶</p><p>回甘</p>`);
  assert.ok(!/script|alert/i.test(out));
});

test("sanitizeHtml: <style> 连内容一起删除（img/onerror 载荷不漏出来）", () => {
  const out = sanitizeHtml(`<p>好茶。</p><style><img/src=x/onerror=alert(1)></style>`);
  assert.equal(out, `<p>好茶。</p>`);
  assert.ok(!/style|onerror|<img/i.test(out));
});

test("sanitizeHtml: 未闭合的 <style> 也不能让载荷漏出", () => {
  const out = sanitizeHtml(`<p>x</p><style><img/src=x/onerror=alert(1)>`);
  assert.ok(!/style/i.test(out), "style 标签必须去掉");
  assert.ok(!/onerror/i.test(out), "onerror 必须去掉");
});

test("sanitizeHtml: `/` 当属性分隔符时事件处理器照样被剥离", () => {
  const out = sanitizeHtml(`<img/src=x/onerror=alert(1)>`);
  assert.ok(!/onerror/i.test(out), `onerror survived: ${out}`);
  assert.ok(out.includes("<img"), "普通 img 本身保留");
});

test("sanitizeHtml: 带空白的事件处理器依然被剥离", () => {
  const out = sanitizeHtml(`<img src="/uploads/x.jpg" onerror="alert(1)" onload=evil()>`);
  assert.ok(!/onerror|onload/i.test(out));
  assert.ok(out.includes("/uploads/x.jpg"));
});

test("sanitizeHtml: javascript: 链接被替换", () => {
  const out = sanitizeHtml(`<a href="javascript:alert(1)">x</a>`);
  assert.ok(!out.includes("javascript:"));
  assert.ok(out.includes("/_blocked_js/"));
});

test("sanitizeHtml: iframe/object 等标签被移除", () => {
  const out = sanitizeHtml(`<p>x</p><iframe src="https://evil.example"></iframe><object data="x"></object>`);
  assert.ok(!/<iframe|<object/i.test(out));
});
