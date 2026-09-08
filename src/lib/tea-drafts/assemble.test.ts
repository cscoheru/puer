/**
 * Tests for assemble.ts (the composition core).
 *
 * These PROVE the trust contract: every output fragment is traceable to the
 * note's prose, the brew fields, or a fixed label — nothing invented, no
 * scores written, source HTML cannot inject.
 *
 * Run: node --test --test-reporter=spec src/lib/tea-drafts/assemble.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleDraft, isAllowedMediaUrl, escapeHtml } from "./assemble.ts";
import type { NormalizedNote } from "./normalize.ts";

const CONFIG = { boardId: "board-1" };
const GOOD_ID = "cjld2cjxh0000qzrmn831i7rn";

function note(over: Partial<NormalizedNote>): NormalizedNote {
  return {
    id: GOOD_ID,
    title: "某山头古树春茶",
    content: "<p>这是一段足够长的品鉴正文，描述了外观汤色与滋味。</p>",
    summary: null,
    teaId: "tea-1",
    authorId: "auth-1",
    source: "manual",
    brewMethod: null,
    waterTemp: null,
    teaWeight: null,
    steepCount: null,
    images: null,
    videoUrl: null,
    createdAt: 1000,
    ...over,
  };
}

test("deterministic id, type, status, tags, board, author, teaId", () => {
  const d = assembleDraft({ note: note({}), config: CONFIG });
  assert.equal(d.id, "tasting-draft_" + GOOD_ID);
  assert.equal(d.type, "tasting");
  assert.equal(d.status, "draft");
  assert.deepEqual(d.tags, ["品鉴"]);
  assert.equal(d.boardId, "board-1");
  assert.equal(d.authorId, "auth-1");
  assert.equal(d.teaId, "tea-1");
});

test("body wraps each paragraph in <p> with escaped text, in order", () => {
  const d = assembleDraft({
    note: note({ content: "<p>第一段。</p><p>第二段。</p>" }),
    config: CONFIG,
  });
  assert.equal(d.content, "<p>第一段。</p><p>第二段。</p>");
});

test("body drops exact-duplicate paragraphs (keeps first) and empty paragraphs", () => {
  const d = assembleDraft({
    note: note({ content: "<p>重复段。</p><p>重复段。</p><p>   </p><p>独有段。</p>" }),
    config: CONFIG,
  });
  assert.equal(d.content, "<p>重复段。</p><p>独有段。</p>");
});

test("body drops exact-match import boilerplate; keeps everything else", () => {
  const d = assembleDraft({
    note: note({ content: "<p>由 Evernote 导入。</p><p>真实正文段。</p>" }),
    config: CONFIG,
    boilerplate: new Set(["由 Evernote 导入。"]),
  });
  assert.equal(d.content, "<p>真实正文段。</p>");
});

test("source <script> cannot inject: stripped entirely, never reaches body", () => {
  const d = assembleDraft({
    note: note({ content: "<p>前置。</p><p><script>alert(1)</script></p><p>后置。</p>" }),
    config: CONFIG,
  });
  // The whole <script> element (and its text) is removed; surrounding paras kept.
  assert.equal(d.content, "<p>前置。</p><p>后置。</p>");
  assert.ok(!d.content.includes("<script>"));
  assert.ok(!d.content.includes("alert"));
});

test("source HTML entities/brackets are escaped in body text", () => {
  const d = assembleDraft({
    note: note({ content: "<p>1 < 2 & 3 > 0</p>" }),
    config: CONFIG,
  });
  assert.equal(d.content, "<p>1 &lt; 2 &amp; 3 &gt; 0</p>");
});

test("body strips Evernote [附件: ...] placeholders (images carry via gallery/video, not as body text)", () => {
  const d = assembleDraft({
    note: note({
      content:
        "<p>正文段，描述汤色。</p><p>协调感更好。[附件: image/jpeg][附件: image/jpeg]</p>",
      images: ["/uploads/evernote/a.jpg", "/uploads/evernote/b.jpg"],
    }),
    config: CONFIG,
  });
  assert.ok(!d.content.includes("附件"), "no placeholder text leaks into body");
  // body is prose only (no inline <img>); images live on the draft for the gallery/video
  assert.equal(d.content, "<p>正文段，描述汤色。</p><p>协调感更好。</p>");
  assert.ok(!d.content.includes("<img"));
  assert.deepEqual(d.images, ["/uploads/evernote/a.jpg", "/uploads/evernote/b.jpg"]);
});

test("a paragraph that is ONLY an attachment placeholder is dropped entirely", () => {
  const d = assembleDraft({
    note: note({ content: "<p>正文段。</p><p>[附件: image/jpeg]</p><p>[附件]</p>" }),
    config: CONFIG,
  });
  assert.equal(d.content, "<p>正文段。</p>");
  assert.ok(!d.content.includes("附件"));
});

test("summary does not contain attachment placeholders", () => {
  const d = assembleDraft({
    note: note({
      title: "标题",
      content: "<p>[附件: image/jpeg]首句内容描述滋味的真实文字。</p>",
    }),
    config: CONFIG,
  });
  assert.ok(!d.summary?.includes("附件"));
  assert.equal(d.summary, "首句内容描述滋味的真实文字。");
});

test("title is whitespace-folded and clipped to TITLE_MAX_LENGTH (200) by code point", () => {
  const long = "标题".repeat(150); // 300 code points
  const d = assembleDraft({ note: note({ title: "  " + long + "  " }), config: CONFIG });
  assert.equal([...d.title].length, 200);
  assert.equal(d.title, "标题".repeat(100));
});

test("summary = first complete non-title-repeat sentence, clipped at sentence boundary", () => {
  const d = assembleDraft({
    note: note({
      title: "标题甲",
      content: "<p>标题甲。这是真正的首句，应当作为摘要。后续内容不再进入摘要。</p>",
    }),
    config: CONFIG,
  });
  assert.equal(d.summary, "这是真正的首句，应当作为摘要。");
});

test("summary is null when there is no qualifying sentence", () => {
  const d = assembleDraft({ note: note({ content: "<p></p>" }), config: CONFIG });
  assert.equal(d.summary, null);
});

test("generated brew-record section only from non-empty fields, with fixed labels", () => {
  const d = assembleDraft({
    note: note({
      content: "<p>正文。</p>",
      brewMethod: "盖碗",
      waterTemp: 95,
      teaWeight: "5g",
      steepCount: 8,
    }),
    config: CONFIG,
  });
  assert.ok(d.content.includes("<h2>冲泡记录</h2>"));
  assert.ok(d.content.includes("<li>冲泡方式：盖碗</li>"));
  assert.ok(d.content.includes("<li>水温：95℃</li>"));
  assert.ok(d.content.includes("<li>投茶量：5g</li>"));
  assert.ok(d.content.includes("<li>耐泡度：8</li>"));
});

test("brew-record section is omitted when all brew fields are empty", () => {
  const d = assembleDraft({ note: note({ content: "<p>正文。</p>" }), config: CONFIG });
  assert.ok(!d.content.includes("冲泡记录"));
});

test("brew fields are copied onto the draft", () => {
  const d = assembleDraft({
    note: note({ brewMethod: "壶泡", waterTemp: 100, teaWeight: "7g", steepCount: 12 }),
    config: CONFIG,
  });
  assert.equal(d.brewMethod, "壶泡");
  assert.equal(d.waterTemp, 100);
  assert.equal(d.teaWeight, "7g");
  assert.equal(d.steepCount, 12);
});

test("media: images copied in order, URL-validated; dangerous schemes dropped", () => {
  const d = assembleDraft({
    note: note({
      images: [
        "/uploads/forum/a.jpg",
        "https://cdn.example/b.jpg",
        "http://insecure/x.jpg", // rejected: not https
        "javascript:alert(1)", // rejected
        "data:image/png;base64,xx", // rejected
        "//protocol.relative/x.jpg", // rejected
      ],
    }),
    config: CONFIG,
  });
  assert.deepEqual(d.images, ["/uploads/forum/a.jpg", "https://cdn.example/b.jpg"]);
});

test("media: non-array images value yields []", () => {
  const d = assembleDraft({ note: note({ images: "not-an-array" }), config: CONFIG });
  assert.deepEqual(d.images, []);
});

test("media: invalid videoUrl dropped to null; valid https preserved", () => {
  const bad = assembleDraft({ note: note({ videoUrl: "javascript:alert(1)" }), config: CONFIG });
  assert.equal(bad.videoUrl, null);
  const good = assembleDraft({ note: note({ videoUrl: "https://cdn.example/v.mp4" }), config: CONFIG });
  assert.equal(good.videoUrl, "https://cdn.example/v.mp4");
});

test("NO tastingScores field is ever produced (design constraint)", () => {
  const d = assembleDraft({
    note: note({ content: "<p>正文足够长，描述外观与汤色滋味回甘。</p>" }),
    config: CONFIG,
  });
  assert.ok(!("tastingScores" in d), "AssembledDraft must not carry tastingScores");
});

test("traceability: body is a substring set of the source paragraphs (no invented prose)", () => {
  const src = "<p>原句一。</p><p>原句二。</p>";
  const d = assembleDraft({ note: note({ content: src }), config: CONFIG });
  // Every <p> body fragment's text must appear verbatim in the source.
  for (const m of d.content.matchAll(/<p>(.*?)<\/p>/g)) {
    assert.ok(src.includes(m[1]), `body fragment not found in source: ${m[1]}`);
  }
});

test("escapeHtml escapes & < >", () => {
  assert.equal(escapeHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
});

test("isAllowedMediaUrl: allowlist boundaries", () => {
  assert.equal(isAllowedMediaUrl("/uploads/forum/x.jpg"), true);
  assert.equal(isAllowedMediaUrl("https://cdn.example/x.jpg"), true);
  assert.equal(isAllowedMediaUrl("http://cdn.example/x.jpg"), false);
  assert.equal(isAllowedMediaUrl("data:image/png;base64,xx"), false);
  assert.equal(isAllowedMediaUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedMediaUrl("file:///etc/passwd"), false);
  assert.equal(isAllowedMediaUrl("//host/x.jpg"), false);
  assert.equal(isAllowedMediaUrl("ftp://host/x"), false);
  assert.equal(isAllowedMediaUrl(""), false);
  assert.equal(isAllowedMediaUrl(undefined), false);
});
