/**
 * Kill-switch tests for the automated-content scripts.
 *
 * PRD v0.3 §12 第3条 / F0: automated votes stop, and AI replies wait for the
 * F0 disclosure label. These switches are the ONLY thing enforcing that —
 * a guard that drifts below the first DB call, or an inversion, would resume
 * bot voting with no failing test.
 *
 * The guards sit before any DB access, so these tests need no database:
 * the script must exit 0, say it is stopped, and never connect.
 *
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");

/** Every bot script that writes votes or comments needs a default-off guard. */
const GUARDED = [
  { file: "auto-vote.mjs", env: "AUTO_VOTE_ENABLED" },
  { file: "auto-boost-new.mjs", env: "AUTO_BOOST_NEW_ENABLED" },
  { file: "boost-essence.mjs", env: "BOOST_ESSENCE_ENABLED" },
  { file: "auto-reply.mjs", env: "AUTO_REPLY_ENABLED" },
  { file: "auto-register.mjs", env: "AUTO_REGISTER_ENABLED" },
];

test("every bot script is default-off: exits 0 without touching the DB", () => {
  for (const { file, env } of GUARDED) {
    const childEnv = { ...process.env };
    delete childEnv[env];
    // Point DATABASE_URL at a dead port: if a script tried to connect it would
    // hang or fail loudly instead of exiting 0.
    childEnv.DATABASE_URL = "postgresql://nobody:nobody@127.0.0.1:1/none";
    const r = spawnSync(process.execPath, [path.join("scripts", file)], {
      cwd: REPO_ROOT,
      env: childEnv,
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(r.status, 0, `${file} should exit 0 when stopped (stderr: ${r.stderr})`);
    assert.match(
      r.stdout + r.stderr,
      /停用|暂停/,
      `${file} should say it is stopped`,
    );
  }
});

test("every script that writes votes or comments has a kill switch", () => {
  const writers = [];
  for (const name of readdirSync(SCRIPTS_DIR)) {
    if (!name.endsWith(".mjs")) continue;
    const src = readFileSync(path.join(SCRIPTS_DIR, name), "utf8");
    if (/INSERT INTO (votes|comments)/i.test(src)) writers.push(name);
  }
  assert.ok(writers.length > 0, "expected at least one vote/comment writer");

  for (const name of writers) {
    const src = readFileSync(path.join(SCRIPTS_DIR, name), "utf8");
    assert.match(
      src,
      /_ENABLED !== "1"/,
      `${name} writes votes/comments but has no default-off kill switch`,
    );
  }
});

test("the kill switch names are discoverable in one place", () => {
  // The switch names live only inside their own scripts otherwise, which is
  // how a typo silently leaves a task off. One table makes them findable.
  const readme = path.join(SCRIPTS_DIR, "KILL_SWITCHES.md");
  const doc = readFileSync(readme, "utf8");
  for (const { env } of GUARDED) {
    assert.match(doc, new RegExp(env), `KILL_SWITCHES.md must document ${env}`);
  }
});
