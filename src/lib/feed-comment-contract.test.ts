import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEED_COMMENT_ERROR_CODES,
  FEED_COMMENT_LIMITS,
  isFeedCommentErrorCode,
  isFeedInlineRepliesEnabled,
  validateFeedCommentText,
} from "./feed-comment-contract.ts";

test("feed gate is exact, default-off and does not accept truthy variants", () => {
  for (const value of [undefined, null, "", "0", "true", "yes", 1, false]) {
    assert.equal(isFeedInlineRepliesEnabled(value), false);
  }
  assert.equal(isFeedInlineRepliesEnabled("1"), true);
});

test("feed text validator uses trimmed UTF-16 code-unit boundaries", () => {
  const failureReason = (input: unknown) => {
    const result = validateFeedCommentText(input);
    return result.ok ? null : result.reason;
  };
  assert.equal(failureReason("茶茶茶茶"), "too_short");
  assert.deepEqual(validateFeedCommentText("  茶茶茶茶茶  "), {
    ok: true,
    value: "茶茶茶茶茶",
    units: 5,
  });
  assert.equal(validateFeedCommentText("a".repeat(2000)).ok, true);
  assert.equal(failureReason("a".repeat(2001)), "too_long");
  assert.equal(validateFeedCommentText("  ").units, 0);
  assert.equal(failureReason(null), "not_string");
});

test("astral Unicode counts as two UTF-16 units, not one code point", () => {
  const result = validateFeedCommentText("茶🍵🍵");
  assert.equal(result.ok, true);
  assert.equal(result.units, 5);
  assert.equal("茶🍵🍵".length, 5);
  assert.equal([..."茶🍵🍵"].length, 3);
});

test("contract owns bounded constants and stable problem codes", () => {
  // These are the two the preview reader actually applies (one human-first
  // query, one AI fallback query); constants without a production reader were
  // removed rather than asserted.
  assert.equal(FEED_COMMENT_LIMITS.humanPreview, 2);
  assert.equal(FEED_COMMENT_LIMITS.aiFallback, 1);
  assert.equal(FEED_COMMENT_LIMITS.maxBodyBytes, 16384);
  assert.equal(FEED_COMMENT_LIMITS.previewCodePoints, 1024);
  assert.equal(FEED_COMMENT_LIMITS.watchdogMs, 60_000);
  assert.equal(new Set(FEED_COMMENT_ERROR_CODES).size, FEED_COMMENT_ERROR_CODES.length);
  assert.equal(isFeedCommentErrorCode("comment.parent_conflict"), true);
  assert.equal(isFeedCommentErrorCode("comment.unknown_new_code"), false);
});
