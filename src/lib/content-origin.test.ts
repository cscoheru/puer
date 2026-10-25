import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ORIGIN_HUMAN,
  ORIGIN_AI_FROM_NOTES,
  ORIGIN_AI_AUTONOMOUS,
  DISCLOSURE_LABELS,
  classifyOrigin,
  parseOrigin,
  disclosureLabelFor,
  originCanFeedDataLayer,
  hasAutopostMarker,
  hasRagpostMarker,
  isNewsDraftId,
  isTastingDraftId,
  type OriginSignals,
} from "./content-origin.ts";

const base: OriginSignals = {
  id: "cmabc123",
  content: "<p>普通正文</p>",
  hasAiOriginal: false,
  authorIsSynthetic: false,
  status: "published",
};

function sig(over: Partial<OriginSignals>): OriginSignals {
  return { ...base, ...over };
}

test("news-draft_ id is always autonomous regardless of other signals", () => {
  assert.equal(classifyOrigin(sig({ id: "news-draft_ab12" })), ORIGIN_AI_AUTONOMOUS);
  // even if it somehow carried an aiOriginal blob
  assert.equal(
    classifyOrigin(sig({ id: "news-draft_ab12", hasAiOriginal: true })),
    ORIGIN_AI_AUTONOMOUS,
  );
});

test("tasting-draft_ id is ai_from_notes", () => {
  assert.equal(
    classifyOrigin(sig({ id: "tasting-draft_62e232f8-x" })),
    ORIGIN_AI_FROM_NOTES,
  );
});

test("auto-post / rag-post HTML markers classify as ai_from_notes", () => {
  assert.equal(
    classifyOrigin(sig({ content: "<p>hi</p><!--auto-post:note-9-->" })),
    ORIGIN_AI_FROM_NOTES,
  );
  assert.equal(
    classifyOrigin(sig({ content: "<!--auto-post-->tail" })),
    ORIGIN_AI_FROM_NOTES,
  );
  assert.equal(
    classifyOrigin(sig({ content: "x<!--rag-post:deadbeef-->y" })),
    ORIGIN_AI_FROM_NOTES,
  );
  assert.equal(hasAutopostMarker("<!--not-auto-post-->"), false, "different comment name");
  assert.equal(hasAutopostMarker("plain text auto-post"), false, "word in prose is not the marker");
  assert.equal(hasAutopostMarker(null), false);
  assert.equal(hasRagpostMarker("<p>nope</p>"), false);
});

test("aiOriginal blob classifies as ai_from_notes even with a bare cuid id", () => {
  assert.equal(classifyOrigin(sig({ hasAiOriginal: true })), ORIGIN_AI_FROM_NOTES);
});

test("synthetic-authored posts are machine content, not human records", () => {
  // F0: 「凡由系统控制的账号…不得以真人身份出现」. The bot-authored 【跟进】
  // posts are fake engagement — labelling them human would let them pass as a
  // real person's record and into the TastingNote data layer.
  const o = classifyOrigin(sig({ authorIsSynthetic: true, id: "cmvhhvg2u001m" }));
  assert.equal(o, ORIGIN_AI_AUTONOMOUS);
});

test("AI-from-notes signals outrank the synthetic-author rule", () => {
  // tea-draft drafts are often published under a bot account, but what they
  // ARE is an AI rendering of the editor's notes — the honest label.
  assert.equal(
    classifyOrigin(sig({ authorIsSynthetic: true, id: "tasting-draft_x" })),
    ORIGIN_AI_FROM_NOTES,
  );
  assert.equal(
    classifyOrigin(sig({ authorIsSynthetic: true, content: "<!--auto-post:n1-->" })),
    ORIGIN_AI_FROM_NOTES,
  );
  assert.equal(
    classifyOrigin(sig({ authorIsSynthetic: true, hasAiOriginal: true })),
    ORIGIN_AI_FROM_NOTES,
  );
});

test("a plain real-user post is human", () => {
  assert.equal(classifyOrigin(sig({ authorIsSynthetic: false })), ORIGIN_HUMAN);
});

test("news-draft takes precedence over tasting-draft signal ordering", () => {
  // A news draft never shares the tasting prefix, but pin precedence anyway.
  assert.equal(isNewsDraftId("news-draft_x"), true);
  assert.equal(isTastingDraftId("news-draft_x"), false);
});

test("parseOrigin distinguishes unpopulated from human", () => {
  assert.equal(parseOrigin(null), null);
  assert.equal(parseOrigin(undefined), null);
  assert.equal(parseOrigin("human"), ORIGIN_HUMAN);
  assert.equal(parseOrigin("ai_from_notes"), ORIGIN_AI_FROM_NOTES);
  assert.equal(parseOrigin("ai_autonomous"), ORIGIN_AI_AUTONOMOUS);
});

test("parseOrigin falls back to human for unknown/garbage values", () => {
  assert.equal(parseOrigin(""), ORIGIN_HUMAN);
  assert.equal(parseOrigin("future_origin"), ORIGIN_HUMAN);
  assert.equal(parseOrigin(42), ORIGIN_HUMAN);
});

test("disclosure labels render only for AI origins", () => {
  assert.equal(disclosureLabelFor(ORIGIN_AI_FROM_NOTES), DISCLOSURE_LABELS.ai_from_notes);
  assert.equal(disclosureLabelFor(ORIGIN_AI_AUTONOMOUS), DISCLOSURE_LABELS.ai_autonomous);
  assert.equal(disclosureLabelFor(ORIGIN_HUMAN), null);
  assert.equal(disclosureLabelFor(null), null);
  assert.equal(DISCLOSURE_LABELS.ai_from_notes, "站长笔记 · AI 整理");
  assert.equal(DISCLOSURE_LABELS.ai_autonomous, "AI 生成 · 非站长品鉴");
});

test("only human origin can feed the TastingNote data layer", () => {
  assert.equal(originCanFeedDataLayer(ORIGIN_HUMAN), true);
  assert.equal(originCanFeedDataLayer(ORIGIN_AI_FROM_NOTES), false);
  assert.equal(originCanFeedDataLayer(ORIGIN_AI_AUTONOMOUS), false);
  // unpopulated rows must be denied until backfill proves they are human
  assert.equal(originCanFeedDataLayer(null), false);
  assert.equal(originCanFeedDataLayer(undefined), false);
});

// ── 来源链接安全 ────────────────────────────────────────────
// 来源链接会被渲染成 href。数据库那一列由写入管线填，但「渲染前不校验」
// 等于把 javascript: 伪协议放进 href —— 纯 URL 判定放这里便于单测。

test("来源链接只接受 http/https，其余一律丢弃", () => {
  const accept = (u: string) => /^https?:\/\//i.test(u.trim()) && u.trim().length <= 2048;
  assert.equal(accept("https://example.com/a"), true);
  assert.equal(accept("http://example.com/a"), true);
  assert.equal(accept("  https://example.com/a  "), true);
  assert.equal(accept("javascript:alert(1)"), false);
  assert.equal(accept("data:text/html,<script>"), false);
  assert.equal(accept("//example.com/a"), false);
  assert.equal(accept("vbscript:x"), false);
  assert.equal(accept(""), false);
  assert.equal(accept("https://" + "x".repeat(3000)), false, "超长串拒绝");
});

// ── 写入侧：人工发帖必须标 origin=human ─────────────────────────────────
//
// 2026-10-24 站长实测的 bug：他在「2012-陈升福元昌古韵圆茶」下发了一条
// 跟进帖，茶品页底部看得见帖子，但**没进站长线**。
//
// 根因：人工发帖的路径**不写 origin** → origin 为 NULL →
// `isHumanOrigin(null)` 为 false → 镜像成品鉴笔记的流程直接跳过
// （`planArticleTastingNote` 返回 "non-human-origin"）→ 这条帖子永远不会
// 变成 TastingNote，也就永远进不了数据层。
//
// 这个 bug **不报错**，只是「帖子没有变成笔记」，所以只能靠断言挡住。
test("人工发帖的路径都标了 origin=human", () => {
  const paths = [
    "../app/api/boards/[slug]/route.ts",
    "../app/api/articles/route.ts",
    "../app/api/sessions/[id]/publish/route.ts",
    "../app/api/import/route.ts",
  ];
  for (const p of paths) {
    const src = readFileSync(new URL(p, import.meta.url), "utf8");
    assert.match(
      src,
      /origin:\s*"human"/,
      `${p} 没有标 origin="human" —— 人工发帖会被镜像流程跳过（进不了数据层）`,
    );
  }
});

test("AI 管线标的仍是 AI 来源（不能被人写成 human）", () => {
  const runner = readFileSync(
    new URL("../lib/tea-drafts/runner.ts", import.meta.url),
    "utf8",
  );
  assert.match(runner, /origin:\s*"ai_from_notes"/);
});
