/**
 * Tests for the AI crawler policy (PRD v0.3 §8 + §11 decision 5:
 * block training crawlers, allow search crawlers).
 *
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_TRAINING_CRAWLERS,
  AI_SEARCH_CRAWLERS,
  DEFAULT_DISALLOWED_PATHS,
  buildRobotsRules,
} from "./ai-crawler-policy.ts";

test("no token is in both the training and the allow list", () => {
  // robots.txt groups are independent: a UA matching two groups takes the
  // longer user-agent string. The same token in both lists makes that
  // resolution meaningless and the policy ambiguous.
  const training = new Set<string>(AI_TRAINING_CRAWLERS);
  for (const ua of AI_SEARCH_CRAWLERS) {
    assert.equal(training.has(ua), false, `${ua} is in both lists`);
  }
});

test("no token appears twice inside the same list", () => {
  for (const list of [AI_TRAINING_CRAWLERS, AI_SEARCH_CRAWLERS]) {
    assert.equal(new Set(list).size, list.length, `duplicate in ${list.join(",")}`);
  }
});

test("training crawlers are refused the whole site", () => {
  const rules = buildRobotsRules();
  for (const ua of AI_TRAINING_CRAWLERS) {
    const rule = rules.find((r) => r.userAgent === ua);
    assert.ok(rule, `${ua} has no rule`);
    assert.deepEqual(rule.disallow, ["/"], `${ua} must be disallowed site-wide`);
    assert.equal(rule.allow, undefined, `${ua} must not also be allowed`);
  }
});

test("search crawlers are allowed", () => {
  const rules = buildRobotsRules();
  for (const ua of AI_SEARCH_CRAWLERS) {
    const rule = rules.find((r) => r.userAgent === ua);
    assert.ok(rule, `${ua} has no rule`);
    assert.deepEqual(rule.allow, ["/"], `${ua} must be allowed`);
    assert.equal(rule.disallow, undefined, `${ua} must not also be disallowed`);
  }
});

test("the PRD-named training crawlers are covered", () => {
  // PRD §8 names these four explicitly.
  for (const ua of ["GPTBot", "ClaudeBot", "CCBot", "Google-Extended"]) {
    assert.ok(
      (AI_TRAINING_CRAWLERS as readonly string[]).includes(ua),
      `${ua} is named by the PRD and must be blocked`,
    );
  }
});

test("the wildcard rule keeps the private paths closed", () => {
  const rules = buildRobotsRules();
  const wildcard = rules.find((r) => r.userAgent === "*");
  assert.ok(wildcard);
  assert.deepEqual(wildcard.allow, ["/"]);
  for (const p of DEFAULT_DISALLOWED_PATHS) {
    assert.ok(wildcard.disallow?.includes(p), `wildcard must disallow ${p}`);
  }
});

test("every rule names a user agent", () => {
  for (const rule of buildRobotsRules()) {
    assert.ok(rule.userAgent.length > 0);
  }
});
