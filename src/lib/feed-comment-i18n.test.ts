import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

/**
 * The inline reply card renders through `_()` on both /forum and /tw/forum.
 * A missing zhCNtoTW entry silently falls back to the simplified key, so a
 * missing translation looks like "繁体外壳 + 简体正文" rather than an error.
 */
test("every inline-reply UI label has a Traditional Chinese entry", () => {
  const component = read("src/components/feed-comment-preview.tsx");
  const translations = read("src/i18n/translations.ts");
  const keys = new Set(
    [...component.matchAll(/(?:_|translate)\(\s*"([^"]+)"/g)].map((match) => match[1]),
  );
  // `_(ERROR_TEXT[draft.error.code])` is passed through the same `_()` but the
  // literal never appears inside the call, so add the table's values directly.
  const errorText = component.match(/const ERROR_TEXT[\s\S]*?\n\};/);
  assert.ok(errorText, "ERROR_TEXT table must stay in the component");
  for (const match of errorText[0].matchAll(/^\s*"comment\.[^"]+":\s*"([^"]+)",?\s*$/gm)) {
    keys.add(match[1]);
  }
  assert.ok(keys.size > 0, "the label extraction must not match nothing");
  const missing = [...keys].filter((key) => !translations.includes(`"${key}":`));
  assert.deepEqual(missing, [], "缺少 zh-TW 映射的文案会静默显示简体");
});

test("server-side feed conversion translates preview comment content", () => {
  const server = read("src/lib/forum-feed-server.ts");
  assert.match(
    server,
    /commentPreview\s*=\s*a\.commentPreview === null[\s\S]{0,300}?content:\s*convertText\(comment\.content\)/,
    "toTraditionalFeed 必须转换 commentPreview.content，否则 TW 首页预览仍是简体",
  );
});
