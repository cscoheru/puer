#!/usr/bin/env node
/**
 * Read-only-after-seed performance evidence for feed inline comment reads.
 *
 * Usage (loopback PostgreSQL only):
 *   DATABASE_URL=postgresql://...@127.0.0.1/... \
 *   FEED_INLINE_TEST_DATABASE_URL=postgresql://...@127.0.0.1/... \
 *   node --import tsx scripts/qa-feed-inline-perf.mjs
 *
 * "Baseline" means the equivalent per-article implementation (2N round trips),
 * not the historical feed, which had no inline comments. The branch executes
 * the exact SQL builders used by src/lib/feed-comment-preview.ts.
 *
 * Both variables must be passed explicitly even when .env defines DATABASE_URL:
 * importing the generated Prisma client loads .env before these checks run, and
 * the product read path binds whatever DATABASE_URL holds at import time.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import {
  feedCommentCandidatesSql,
  feedCommentErrorCategory,
  feedVisibleCountsSql,
  loadFeedCommentBatch,
  readPreviewCandidates,
  readVisibleCounts,
} from "../src/lib/feed-comment-preview.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.FEED_INLINE_TEST_DATABASE_URL;
assert.ok(url, "FEED_INLINE_TEST_DATABASE_URL is required; DATABASE_URL alone is never used");
const parsed = new URL(url);
assert.ok(["postgresql:", "postgres:"].includes(parsed.protocol));
// `new URL("postgresql://u@[::1]:5432/db").hostname` is the bracketed "[::1]",
// so an IPv6 loopback URL would be rejected by a plain allowlist check.
const loopbackHost = (hostname) => hostname.replace(/^\[|\]$/g, "");
assert.ok(["127.0.0.1", "localhost", "::1"].includes(loopbackHost(parsed.hostname)), "performance QA is loopback-only");
// feed-comment-preview.ts binds its Prisma client from DATABASE_URL at import
// time, which already happened above, so the assignment below cannot redirect
// it. Importing the generated Prisma client also loads the repo's .env, so a
// missing command-line value can silently become a non-loopback database. If
// the two URLs disagree, proveStatementTimeout() would hit the wrong (or no)
// database and still "pass" on two null results. Refuse.
assert.ok(
  process.env.DATABASE_URL,
  "DATABASE_URL must be passed explicitly: the product read path binds it at import time",
);
{
  const ambient = new URL(process.env.DATABASE_URL);
  assert.equal(ambient.hostname, parsed.hostname, "DATABASE_URL host must match FEED_INLINE_TEST_DATABASE_URL");
  assert.equal(ambient.port, parsed.port, "DATABASE_URL port must match FEED_INLINE_TEST_DATABASE_URL");
  assert.equal(ambient.pathname, parsed.pathname, "DATABASE_URL database must match FEED_INLINE_TEST_DATABASE_URL");
}
process.env.DATABASE_URL = url;

const prisma = new PrismaClient({ datasources: { db: { url } } });
const report = {
  startedAt: new Date().toISOString(),
  machine: {
    platform: os.platform(), arch: os.arch(), release: os.release(),
    cpu: os.cpus()[0]?.model, cores: os.cpus().length,
    memoryBytes: os.totalmem(), node: process.version,
  },
  method: {
    baseline: "Equivalent per-article candidate + count reads: 2N sequential round trips.",
    branch: "Exact production SQL builders: two sequential page-scoped reads. The app additionally races them with Promise.allSettled, so this is a conservative SQL-cost comparison.",
    interleaving: "Alternating baseline/branch order for 20 warm iterations; five fresh-connection samples per page size.",
    coldDefinition: "Fresh PostgreSQL connection, not a restarted server or purged OS page cache.",
  },
  fixtures: {},
  measurements: [],
  explains: {},
};

const ids = Array.from({ length: 300 }, (_, n) => `qa-perf-article-${String(n).padStart(3, "0")}`);
const users = {
  human: "qa-perf-user-human",
  bot: "qa-perf-user-bot",
};

async function seed() {
  await prisma.article.deleteMany({ where: { id: { startsWith: "qa-perf-" } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: "qa-perf-user-" } } });
  await prisma.board.deleteMany({ where: { id: "qa-perf-board" } });
  await prisma.board.create({ data: { id: "qa-perf-board", name: "QA Perf", slug: "qa-perf" } });
  await prisma.user.createMany({ data: [
    { id: users.human, uid: 889001, username: "qa_perf_human", email: "qa-perf-human@example.invalid",
      role: "user", isSynthetic: false, level: 1, preferenceTags: [] },
    { id: users.bot, uid: 889002, username: "qa_perf_bot", email: "qa-perf-bot@example.invalid",
      role: "system", isSynthetic: true, level: 1, preferenceTags: [] },
  ] });
  const now = Date.now();
  await prisma.article.createMany({ data: ids.map((id, n) => ({
    id, type: "discussion", title: `QA perf ${n}`, content: "bounded read fixture",
    tags: [], images: [], boardId: "qa-perf-board", status: "published", visibility: "public",
    origin: "human", authorId: users.human,
    createdAt: new Date(now - n * 60_000), updatedAt: new Date(now - n * 60_000),
  })) });

  let total = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    await prisma.comment.createMany({ data: batch });
    total += batch.length;
    batch = [];
  };
  for (let a = 0; a < ids.length; a++) {
    // 270 steady cards, 29 skewed cards and one pathological 20k-comment card.
    const count = a < 270 ? 4 : a < 299 ? 1000 : 20_000;
    for (let n = 0; n < count; n++) {
      const ai = n % 5 === 4;
      batch.push({
        id: `qa-perf-comment-${a}-${n}`,
        articleId: ids[a],
        authorId: ai ? users.bot : users.human,
        content: `${"茶".repeat(80)} ${n}`,
        images: [], status: "published", origin: ai ? "ai_autonomous" : "human",
        createdAt: new Date(now - (a * 60_000 + n)),
      });
      if (batch.length === 5000) await flush();
    }
  }
  await flush();
  await prisma.$executeRaw`ANALYZE comments`;
  await prisma.$executeRaw`ANALYZE users`;
  report.fixtures = {
    articles: ids.length,
    comments: total,
    steady: { articles: 270, commentsPerArticle: 4 },
    skewed: { articles: 29, commentsPerArticle: 1000 },
    pathological: { articles: 1, commentsPerArticle: 20_000 },
    viewer: "anonymous (published, visible origins only)",
  };
}

async function client() {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}

function pgQuery(sql) {
  assert.equal(sql.strings.length, sql.values.length + 1, "unexpected Prisma SQL template shape");
  // Prisma's public Sql object stores template fragments and values; `.sql`
  // renders `?` placeholders for Prisma's own driver, not for node-postgres.
  const text = sql.strings.reduce(
    (acc, fragment, index) => `${acc}${index > 0 ? `$${index}` : ""}${fragment}`,
    "",
  );
  return { text, values: sql.values };
}

const query = (c, sql) => c.query(pgQuery(sql));
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
};
const stats = (values) => ({
  samples: values.length,
  p50Ms: Number(percentile(values, 0.5).toFixed(3)),
  p95Ms: Number(percentile(values, 0.95).toFixed(3)),
  minMs: Number(Math.min(...values).toFixed(3)),
  maxMs: Number(Math.max(...values).toFixed(3)),
});

async function baseline(c, pageIds) {
  let rows = 0;
  for (const id of pageIds) {
    rows += (await query(c, feedCommentCandidatesSql([id], null))).rowCount;
    rows += (await query(c, feedVisibleCountsSql([id], null))).rowCount;
  }
  return rows;
}

// 只测生产默认口径：`feed.aiReplies` 关闭时 AI 分支不进 SQL。后台把开关打开后会多一段
// LATERAL 的 AI 兜底（每帖至多 1 行），本脚本不覆盖那个形状——需要时给两个 builder 传
// `{ aiPreview: true }` 另跑一轮。
async function branch(c, pageIds) {
  const candidates = await query(c, feedCommentCandidatesSql(pageIds, null));
  const counts = await query(c, feedVisibleCountsSql(pageIds, null));
  assert.ok(candidates.rowCount <= 3 * pageIds.length, "candidate bound exceeded");
  for (const row of candidates.rows) {
    assert.ok([...row.content].length <= 1024, "preview code-point bound exceeded");
  }
  assert.ok(counts.rowCount <= pageIds.length, "count group bound exceeded");
  return { candidateRows: candidates.rowCount, countRows: counts.rowCount };
}

async function measure(n) {
  const pageIds = ids.slice(0, n);
  const c = await client();
  const baselineMs = [];
  const branchMs = [];
  let bounds;
  try {
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) {
        let t = performance.now();
        await baseline(c, pageIds);
        baselineMs.push(performance.now() - t);
        t = performance.now();
        bounds = await branch(c, pageIds);
        branchMs.push(performance.now() - t);
      } else {
        let t = performance.now();
        bounds = await branch(c, pageIds);
        branchMs.push(performance.now() - t);
        t = performance.now();
        await baseline(c, pageIds);
        baselineMs.push(performance.now() - t);
      }
    }
  } finally { await c.end(); }

  const cold = { baselineMs: [], branchMs: [] };
  for (let i = 0; i < 5; i++) {
    for (const [name, fn] of (i % 2 === 0
      ? [["baselineMs", baseline], ["branchMs", branch]]
      : [["branchMs", branch], ["baselineMs", baseline]])) {
      const fresh = await client();
      try {
        const t = performance.now();
        await fn(fresh, pageIds);
        cold[name].push(performance.now() - t);
      } finally { await fresh.end(); }
    }
  }
  report.measurements.push({
    pageSize: n,
    warm: { baseline: stats(baselineMs), branch: stats(branchMs) },
    freshConnection: { baseline: stats(cold.baselineMs), branch: stats(cold.branchMs) },
    branchBounds: bounds,
    queryCounts: { baseline: 2 * n, branch: 2 },
  });
  console.log(`N=${n} warm baseline p95=${stats(baselineMs).p95Ms}ms branch p95=${stats(branchMs).p95Ms}ms; queries ${2 * n} -> 2`);
}

async function explain(n) {
  const pageIds = ids.slice(0, n);
  const c = await client();
  try {
    for (const [name, sql] of [
      ["candidates", feedCommentCandidatesSql(pageIds, null)],
      ["counts", feedVisibleCountsSql(pageIds, null)],
    ]) {
      const rendered = pgQuery(sql);
      const result = await c.query({
        text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${rendered.text}`,
        values: rendered.values,
      });
      report.explains[`${name}-N${n}`] = result.rows[0]["QUERY PLAN"];
    }
  } finally { await c.end(); }
}

async function proveStatementTimeout() {
  const locker = await client();
  await locker.query("BEGIN");
  await locker.query('LOCK TABLE comments IN ACCESS EXCLUSIVE MODE');
  const started = performance.now();
  const failures = [];
  // Record why each read rejected: two nulls alone would also be produced by a
  // connection error, which would make the timeout proof pass vacuously.
  const record = (operation, read) => async () => {
    try {
      return await read();
    } catch (error) {
      failures.push({ operation, category: feedCommentErrorCategory(error) });
      throw error;
    }
  };
  const articleIds = ids.slice(0, 24);
  try {
    const batch = await loadFeedCommentBatch(articleIds, null, "qa-perf-statement-timeout", {
      previews: record("preview", () => readPreviewCandidates(articleIds, null)),
      counts: record("count", () => readVisibleCounts(articleIds, null)),
    });
    report.statementTimeout = {
      elapsedMs: Number((performance.now() - started).toFixed(1)),
      previews: batch.previews === null ? "null (degraded)" : "unexpectedly fulfilled",
      counts: batch.counts === null ? "null (degraded)" : "unexpectedly fulfilled",
      failures,
      configuredTimeoutMs: 1500,
      lock: "ACCESS EXCLUSIVE on comments, released in finally",
    };
    assert.equal(batch.previews, null);
    assert.equal(batch.counts, null);
    assert.equal(failures.length, 2, "both reads must reject while the table is locked");
    for (const failure of failures) {
      assert.equal(
        failure.category,
        "statement_timeout",
        `${failure.operation} read must time out, not fail for another reason`,
      );
    }
  } finally {
    await locker.query("ROLLBACK");
    await locker.end();
  }
}

try {
  await seed();
  report.postgres = (await prisma.$queryRaw`SELECT version() AS version`)[0].version;
  for (const n of [24, 30, 300]) await measure(n);
  await explain(24);
  await explain(300);
  await proveStatementTimeout();
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await prisma.article.deleteMany({ where: { id: { startsWith: "qa-perf-" } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: "qa-perf-user-" } } });
  await prisma.board.deleteMany({ where: { id: "qa-perf-board" } }).catch(() => {});
  await prisma.$disconnect();
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const out = path.join(ROOT, ".gstack", "qa-reports", `feed-inline-perf-${stamp}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Performance evidence: ${out}`);
}
