/**
 * Fail-closed detail-visibility matrix for `canViewArticleDetail`.
 *
 * These tests PROVE the policy that the old code violated: a draft or
 * pending_review article must never leak its title/body to an anonymous or
 * non-owner visitor, an archived article is admin-only, and any unrecognized
 * status is denied rather than shown. Every branch of the matrix is covered so
 * a regression in the switch is caught immediately.
 *
 * Run: node --test --test-reporter=spec src/lib/article-visibility.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { canViewArticleDetail } from "./article-visibility.ts";

const OWNER = "user-owner";
const OTHER = "user-other";

interface Case {
  name: string;
  article: { status: string; visibility: string; authorId: string | null };
  viewer: { userId?: string | null; isAdmin?: boolean };
  expected: boolean;
}

const cases: Case[] = [
  // ── published + public → anyone ──────────────────────────────────────────
  {
    name: "published/public: anonymous viewer sees it",
    article: { status: "published", visibility: "public", authorId: OWNER },
    viewer: {},
    expected: true,
  },
  {
    name: "published/public: owner sees it",
    article: { status: "published", visibility: "public", authorId: OWNER },
    viewer: { userId: OWNER },
    expected: true,
  },
  {
    name: "published/public: other user sees it",
    article: { status: "published", visibility: "public", authorId: OWNER },
    viewer: { userId: OTHER },
    expected: true,
  },
  {
    name: "published/public: admin sees it",
    article: { status: "published", visibility: "public", authorId: OWNER },
    viewer: { userId: OTHER, isAdmin: true },
    expected: true,
  },

  // ── published + private → author or admin only ───────────────────────────
  {
    name: "published/private: anonymous viewer denied",
    article: { status: "published", visibility: "private", authorId: OWNER },
    viewer: {},
    expected: false,
  },
  {
    name: "published/private: owner sees it",
    article: { status: "published", visibility: "private", authorId: OWNER },
    viewer: { userId: OWNER },
    expected: true,
  },
  {
    name: "published/private: other user denied",
    article: { status: "published", visibility: "private", authorId: OWNER },
    viewer: { userId: OTHER },
    expected: false,
  },
  {
    name: "published/private: admin sees it",
    article: { status: "published", visibility: "private", authorId: OWNER },
    viewer: { isAdmin: true },
    expected: true,
  },

  // ── draft → author or admin (the bug that leaked to anon before) ─────────
  {
    name: "draft/public: anonymous viewer denied (was the leak)",
    article: { status: "draft", visibility: "public", authorId: OWNER },
    viewer: {},
    expected: false,
  },
  {
    name: "draft/private: anonymous viewer denied",
    article: { status: "draft", visibility: "private", authorId: OWNER },
    viewer: {},
    expected: false,
  },
  {
    name: "draft: owner sees it",
    article: { status: "draft", visibility: "public", authorId: OWNER },
    viewer: { userId: OWNER },
    expected: true,
  },
  {
    name: "draft: other user denied",
    article: { status: "draft", visibility: "public", authorId: OWNER },
    viewer: { userId: OTHER },
    expected: false,
  },
  {
    name: "draft: admin sees it",
    article: { status: "draft", visibility: "public", authorId: OWNER },
    viewer: { isAdmin: true },
    expected: true,
  },

  // ── pending_review → author or admin ─────────────────────────────────────
  {
    name: "pending_review: anonymous viewer denied",
    article: { status: "pending_review", visibility: "public", authorId: OWNER },
    viewer: {},
    expected: false,
  },
  {
    name: "pending_review: owner sees it",
    article: { status: "pending_review", visibility: "public", authorId: OWNER },
    viewer: { userId: OWNER },
    expected: true,
  },
  {
    name: "pending_review: admin sees it",
    article: { status: "pending_review", visibility: "public", authorId: OWNER },
    viewer: { isAdmin: true },
    expected: true,
  },

  // ── archived → admin only (not even author) ──────────────────────────────
  {
    name: "archived: anonymous viewer denied",
    article: { status: "archived", visibility: "public", authorId: OWNER },
    viewer: {},
    expected: false,
  },
  {
    name: "archived: owner denied",
    article: { status: "archived", visibility: "public", authorId: OWNER },
    viewer: { userId: OWNER },
    expected: false,
  },
  {
    name: "archived: admin sees it",
    article: { status: "archived", visibility: "public", authorId: OWNER },
    viewer: { isAdmin: true },
    expected: true,
  },

  // ── unknown status → deny everyone (fail-closed) ─────────────────────────
  {
    name: "unknown status: anonymous denied",
    article: { status: "weird", visibility: "public", authorId: OWNER },
    viewer: {},
    expected: false,
  },
  {
    name: "unknown status: owner denied (fail-closed)",
    article: { status: "weird", visibility: "public", authorId: OWNER },
    viewer: { userId: OWNER },
    expected: false,
  },
  {
    name: "unknown status: admin denied (fail-closed)",
    article: { status: "weird", visibility: "public", authorId: OWNER },
    viewer: { isAdmin: true },
    expected: false,
  },
  {
    name: "empty status: denied",
    article: { status: "", visibility: "public", authorId: OWNER },
    viewer: { userId: OWNER, isAdmin: true },
    expected: false,
  },

  // ── null authorId: ownership can never match ─────────────────────────────
  {
    name: "draft with null authorId: a userId claiming ownership still denied",
    article: { status: "draft", visibility: "public", authorId: null },
    viewer: { userId: OWNER },
    expected: false,
  },
  {
    name: "draft with null authorId: admin still sees it",
    article: { status: "draft", visibility: "public", authorId: null },
    viewer: { isAdmin: true },
    expected: true,
  },
  {
    name: "published/public with null authorId: anonymous sees it",
    article: { status: "published", visibility: "public", authorId: null },
    viewer: {},
    expected: true,
  },
];

for (const c of cases) {
  test(c.name, () => {
    assert.equal(
      canViewArticleDetail(c.article, c.viewer),
      c.expected,
      `article=${JSON.stringify(c.article)} viewer=${JSON.stringify(c.viewer)}`,
    );
  });
}
