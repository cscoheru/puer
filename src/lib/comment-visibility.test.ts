import { test } from "node:test";
import assert from "node:assert/strict";
import { commentVisibility } from "./comment-visibility.ts";
import { AI_COMMENT_ORIGINS } from "./content-origin.ts";

const anonymous = commentVisibility(null);
const alice = commentVisibility({ id: "alice-id", role: "user", isSynthetic: false });
const bob = commentVisibility({ id: "bob-id", role: "user", isSynthetic: false });
const moderator = commentVisibility({ id: "mod-id", role: "moderator", isSynthetic: false });
const syntheticAdmin = commentVisibility({ id: "bot-id", role: "admin", isSynthetic: true });

test("anonymous policy is published-only in both adapters", () => {
  assert.equal(anonymous.moderator, false);
  assert.deepEqual(anonymous.prismaWhere.AND, [
    { OR: [{ author: { isSynthetic: false } }, { origin: { in: [...AI_COMMENT_ORIGINS] } }] },
    { status: "published" },
  ]);
  assert.match(anonymous.sql.sql, /c\.status = 'published'/);
  assert.doesNotMatch(anonymous.sql.sql, /pending_review/);
});

test("two users get independent own-pending parameters, never shared viewer state", () => {
  assert.notEqual(alice.userId, bob.userId);
  assert.ok(alice.sql.values.includes("alice-id"));
  assert.ok(bob.sql.values.includes("bob-id"));
  assert.equal(alice.sql.values.includes("bob-id"), false);
  assert.equal(bob.sql.values.includes("alice-id"), false);
  assert.match(alice.sql.sql, /pending_review/);
  assert.doesNotMatch(alice.sql.sql, /alice-id/);
});

test("moderator status is unrestricted, but origin visibility still applies", () => {
  assert.equal(moderator.moderator, true);
  assert.ok(Array.isArray(moderator.prismaWhere.AND));
  assert.equal(moderator.prismaWhere.AND.length, 1);
  assert.doesNotMatch(moderator.sql.sql, /c\.status/);
  assert.match(moderator.sql.sql, /isSynthetic/);
  assert.match(moderator.sql.sql, /origin/);
});

test("synthetic admin does not inherit moderator visibility", () => {
  assert.equal(syntheticAdmin.moderator, false);
  assert.match(syntheticAdmin.sql.sql, /pending_review/);
  assert.ok(syntheticAdmin.sql.values.includes("bot-id"));
});

test("human and AI selection derive from the shared origin policy", () => {
  assert.match(alice.humanSql.sql, /u\."isSynthetic" = FALSE/);
  // Prisma binds JS arrays as jsonb; the origins must reach SQL as scalars.
  assert.equal(alice.aiSql.values.some((value) => Array.isArray(value)), false);
  for (const origin of AI_COMMENT_ORIGINS) {
    assert.ok(alice.aiSql.values.includes(origin));
  }
  assert.equal(alice.humanSql.sql.includes("origin"), false);
});
