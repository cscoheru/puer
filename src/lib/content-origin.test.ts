import { test } from "node:test";
import assert from "node:assert/strict";
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
