#!/usr/bin/env node

/**
 * auto-post.mjs — Trustworthy tea-draft CLI (v2).
 *
 * Replaces the old pipeline (random author/board/image shuffle + DeepSeek
 * rewrite + slideshow video → published post). The new pipeline turns the
 * CONFIGURED author's own manual tasting notes into at most one reviewable
 * `status=draft` Article per run, with every word traceable to the note. No
 * randomization, no video generation. By default no model call either; an
 * opt-in grounded rewrite (Phase D) is available via AUTO_TEA_DRAFT_ADAPT=1.
 *
 * It is a THIN CLI around `runTeaDraftRunner` (src/lib/tea-drafts/runner.ts):
 *   1. parse env (author / board / allowlist / caps) + argv (--apply/--dry-run)
 *   2. build an injected PrismaClient (same adapter as src/lib/prisma.ts)
 *   3. call runTeaDraftRunner and print a structured report
 *
 * Runtime: this imports TypeScript modules (the runner + generated Prisma
 * client), so it runs under the tsx loader:
 *     node --import tsx scripts/auto-post.mjs            # dry-run (default)
 *     node --import tsx scripts/auto-post.mjs --apply     # write the draft
 *
 * Safety: --dry-run is the default and writes nothing. The runner additionally
 * self-limits via a transaction-scoped advisory lock, an "unreviewed draft
 * exists" gate, and a per-Shanghai-day cap. Re-running for the same note is
 * idempotent (deterministic `tasting-draft_${noteId}` id).
 *
 * Required env:
 *   DATABASE_URL                — Postgres connection string
 *   AUTO_TEA_DRAFT_AUTHOR_ID    — the only author whose notes may be drafted
 *   AUTO_TEA_DRAFT_BOARD_ID     — the board auto-drafts are posted to
 *   AUTO_TEA_DRAFT_NOTE_IDS     — comma-separated allowlist of TastingNote ids
 * Optional env:
 *   AUTO_DRAFT_LIMIT            — max drafts per run        (default 1)
 *   AUTO_DRAFT_DAILY_CAP        — max drafts per Shanghai day (default 1)
 *   AUTO_DRAFT_CANDIDATE_FETCH  — candidate read backstop    (default 200)
 *   AUTO_TEA_DRAFT_ADAPT        — "1" enables a grounded LLM rewrite of the
 *                                 created draft's body/summary (Phase D, opt-in;
 *                                 runs AFTER the tx commits, verbatim is the
 *                                 fallback). Unset / any other value = verbatim.
 *   DEEPSEEK_API_KEY            — required only when AUTO_TEA_DRAFT_ADAPT=1
 *                                 (already present for moderation; reused).
 */

import { PrismaClient } from "../src/generated/prisma/client.js";
import { runTeaDraftRunner, RUNNER_DEFAULTS } from "../src/lib/tea-drafts/runner.ts";
import { deepSeekAdapt } from "../src/lib/tea-drafts/adapt.ts";

// ── argv ────────────────────────────────────────────────────────────

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

// ── env → config ────────────────────────────────────────────────────

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`ERROR: missing required env ${name}. Set it before running.`);
    process.exit(1);
  }
  return v;
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`ERROR: ${name} must be a non-negative integer (got "${raw}").`);
    process.exit(1);
  }
  return n;
}

const AUTHOR_ID = required("AUTO_TEA_DRAFT_AUTHOR_ID");
const BOARD_ID = required("AUTO_TEA_DRAFT_BOARD_ID");
// NOTE_IDS is optional: an empty/unset value = wildcard mode (any of the
// configured author's manual/evernote notes is eligible). The source, author,
// and tea-dedup gates still bound selection. Set it explicitly to restrict to a
// curated subset.
const noteIds = new Set(
  (process.env.AUTO_TEA_DRAFT_NOTE_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const config = {
  authorId: AUTHOR_ID,
  noteIds,
  boardId: BOARD_ID,
  limit: intEnv("AUTO_DRAFT_LIMIT", RUNNER_DEFAULTS.limit),
  dailyCap: intEnv("AUTO_DRAFT_DAILY_CAP", RUNNER_DEFAULTS.dailyCap),
  maxUnreviewed: intEnv("AUTO_DRAFT_MAX_UNREVIEWED", RUNNER_DEFAULTS.maxUnreviewed),
  candidateFetchLimit: intEnv("AUTO_DRAFT_CANDIDATE_FETCH", RUNNER_DEFAULTS.candidateFetchLimit),
};

// ── Phase D: opt-in grounded adapt ──────────────────────────────────
// AUTO_TEA_DRAFT_ADAPT="1" enables a grounded LLM rewrite of the created
// draft's body/summary AFTER the transaction commits; the verbatim draft is
// always created first as the fail-safe fallback. Any other value / unset =
// today's verbatim path (adaptDraft undefined → runner skips the rewrite).
// deepSeekAdapt is side-effect-free to import; it only touches the network
// when actually invoked, so the off path makes zero model calls.
const adaptOn = process.env.AUTO_TEA_DRAFT_ADAPT === "1";
const adaptDraft = adaptOn ? (source) => deepSeekAdapt({ source }) : undefined;

// ── prisma client (injected, same adapter as src/lib/prisma.ts) ─────

function makePrisma() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: missing required env DATABASE_URL.");
    process.exit(1);
  }
  // After prisma 6 downgrade (no more @prisma/adapter-pg), use the
  // traditional pg-backed PrismaClient with datasources config.
  return new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── report ──────────────────────────────────────────────────────────

function report(res) {
  log(`mode=${res.dryRun ? "dry-run" : "apply"} status=${res.status} candidates=${res.candidateCount}`);
  if (res.selected.length > 0) {
    log(`selected (${res.selected.length}):`);
    for (const d of res.selected) {
      log(`  • ${d.id}  “${d.title}”  [tea=${d.teaId ?? "-"} board=${d.boardId}]`);
    }
  }
  if (res.created.length > 0) log(`created (${res.created.length}): ${res.created.join(", ")}`);
  if (res.alreadyExisted.length > 0)
    log(`alreadyExisted (${res.alreadyExisted.length}): ${res.alreadyExisted.join(", ")}`);
  if (res.rejected.length > 0) {
    log(`rejected (${res.rejected.length}):`);
    for (const r of res.rejected) log(`  • ${r.id}  → ${r.reason}`);
  }
  if (res.adapted.length > 0) {
    log(`adapted (${res.adapted.length}):`);
    for (const a of res.adapted) {
      const tag = a.ok
        ? a.updated
          ? "applied"
          : "skipped: human-edited first"
        : `skipped: ${a.reason}`;
      log(`  • ${a.id}  → ${tag}`);
    }
  }
}

// ── main ────────────────────────────────────────────────────────────

async function main() {
  log(`=== Tea-draft runner (${DRY_RUN ? "dry-run" : "APPLY"}) ===`);
  log(`author=${AUTHOR_ID} board=${BOARD_ID} allowlist=${noteIds.size} limit=${config.limit} dailyCap=${config.dailyCap} adapt=${adaptOn ? "on" : "off"}`);

  const prisma = makePrisma();
  try {
    const res = await runTeaDraftRunner({ prisma, config, dryRun: DRY_RUN, adaptDraft });
    report(res);
    if (DRY_RUN && res.selected.length > 0) {
      const tail = adaptOn ? " (grounded adapt would then rewrite the created draft)" : "";
      log(`Dry-run only — no rows written. Re-run with --apply to create the draft(s).${tail}`);
    }
    log(`=== Done: status=${res.status} ===`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
