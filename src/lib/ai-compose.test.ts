/**
 * 「AI 创作」的权限与提示词 —— 钉住 2026-11-06 的可见性要求。
 *
 * 站长原话：「只有站长和 admin 用户才能看到，其他用户看不到（切记！）」。
 * 这些断言的作用是：谁把闸门改成按等级、或者让 editor 角色自动获得资格，
 * 这里会红。
 *
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_DRAFT_TAGS,
  buildAiComposePrompt,
  canUseAiCompose,
  stripCodeFence,
} from "./ai-compose.ts";
import { sanitizeNoteHtml, stripToContentTags } from "./tea-drafts/sanitize.ts";

const admin = { id: "u-admin", role: "admin", uid: 1003 };
const ownerByUid = { id: "u-owner", role: "user", uid: 1001 }; // 渔夫
const editorOnly = { id: "u-editor", role: "editor", uid: 2001 };
const ordinary = { id: "u-ordinary", role: "user", uid: 3001, level: 4 };

test("管理员能用 AI 创作", () => {
  assert.equal(canUseAiCompose(admin), true);
});

test("站长（uid 白名单，与站长线同一份名单）能用 AI 创作", () => {
  assert.equal(canUseAiCompose(ownerByUid), true);
});

test("普通用户不能用（哪怕等级很高）", () => {
  assert.equal(canUseAiCompose(ordinary), false);
});

test("只有 editor 角色、但不在站长 uid 白名单里 —— 不能用", () => {
  // 口径是「站长和 admin」，站长按 uid 白名单认；role=editor 本身不是资格。
  assert.equal(canUseAiCompose(editorOnly), false);
});

test("未登录 / 空 actor / 没有 uid 一律拒绝", () => {
  assert.equal(canUseAiCompose(null), false);
  assert.equal(canUseAiCompose(undefined), false);
  assert.equal(canUseAiCompose({ id: "x", role: "user" }), false);
});

test("合成账号没有 AI 创作权限（哪怕 uid 在白名单里）", () => {
  assert.equal(
    canUseAiCompose({ id: "bot", role: "user", uid: 1001, isSynthetic: true }),
    false,
  );
  assert.equal(
    canUseAiCompose({ id: "bot", role: "admin", uid: 1001, isSynthetic: true }),
    false,
  );
});

test("白名单可以用 env 覆盖；写坏时回落默认值", () => {
  const env = { EDITOR_AUTHOR_UIDS: "1001,1003" };
  assert.equal(canUseAiCompose({ id: "x", role: "user", uid: 1003 }, env), true);
  assert.equal(canUseAiCompose({ id: "x", role: "user", uid: 1002 }, env), false);
  // 写坏 → 回落默认 1001/1002/1003，而不是放行所有人
  assert.equal(
    canUseAiCompose({ id: "x", role: "user", uid: 1001 }, { EDITOR_AUTHOR_UIDS: "abc,," }),
    true,
  );
  assert.equal(
    canUseAiCompose({ id: "x", role: "user", uid: 9999 }, { EDITOR_AUTHOR_UIDS: "abc,," }),
    false,
  );
});

test("提示词带上标题 / 版块 / 茶品作为上下文", () => {
  const { system, user } = buildAiComposePrompt({
    prompt: "写一篇关于今年新茶的帖子",
    title: "2020 冰岛生普 开汤记录",
    boardName: "经典普洱",
    tea: { name: "冰岛", brand: "勐库", year: 2020 },
  });
  assert.match(user, /2020 冰岛生普 开汤记录/);
  assert.match(user, /经典普洱/);
  assert.match(user, /冰岛 · 勐库 · 2020 年/);
  assert.match(user, /写一篇关于今年新茶的帖子/);
  assert.match(system, /<p>/);
  // 没给的信息不能凭空出现
  assert.doesNotMatch(user, /价格/);
});

test("提示词里不出现 json —— 否则 DeepSeek/GLM 会走 json_object 模式", () => {
  const { system, user } = buildAiComposePrompt({
    prompt: "随便写点喝茶的感受",
    title: "",
    boardName: "",
    tea: null,
  });
  assert.equal(/json/i.test(`${system}\n${user}`), false);
});

test("白名单标签与提示词保持一致（不放开代码会删掉的标签）", () => {
  const { system } = buildAiComposePrompt({ prompt: "写点东西" });
  for (const tag of AI_DRAFT_TAGS) {
    assert.ok(system.includes(`<${tag}>`), `system prompt 缺少 <${tag}>`);
  }
});

test("stripCodeFence 去掉模型偶发的 markdown 围栏", () => {
  assert.equal(stripCodeFence("```html\n<p>你好</p>\n```"), "<p>你好</p>");
  assert.equal(stripCodeFence("```\n<p>你好</p>\n```"), "<p>你好</p>");
  assert.equal(stripCodeFence("  <p>你好</p>  "), "<p>你好</p>");
  assert.equal(stripCodeFence("```html\n<p>你好</p>"), "<p>你好</p>");
  assert.equal(stripCodeFence(""), "");
});

test("接口的净化链：围栏与危险标签都不会进正文", () => {
  // 与 src/app/api/ai/compose/route.ts 里那行保持同一条链：
  // stripCodeFence → sanitizeNoteHtml → stripToContentTags
  const raw = "```html\n<p>好茶。</p><style><img/src=x/onerror=alert(1)></style>\n```";
  const html = stripToContentTags(sanitizeNoteHtml(stripCodeFence(raw)));
  assert.equal(html, "<p>好茶。</p>");
});
