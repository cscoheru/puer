#!/usr/bin/env node
/**
 * One-command, hermetic QA for the inline feed reply P0.
 *
 *   npm run qa:feed:inline
 *
 * What it owns:
 *   - a staging tree with no .env* and no inherited provider credentials
 *   - a disposable loopback PostgreSQL 16 instance on a random port
 *   - a loopback OpenAI-compatible moderation double
 *   - one Next dev server per gate phase (off first, then on)
 *   - a real Chromium session driven by qa-feed-inline-browser.mjs
 *   - artifacts under .gstack/qa-reports/ and owned-process/temp cleanup
 *
 * It never reads or writes production. A missing prerequisite or an egress
 * guard that fails to load is reported as BLOCKED, not downgraded to mocks.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const startedAt = Date.now();
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
const artifacts = path.join(REPO, ".gstack", "qa-reports", `feed-inline-${runId}`);
fs.mkdirSync(artifacts, { recursive: true });

const state = {
  runId,
  machine: { platform: os.platform(), arch: os.arch(), release: os.release(), cpus: os.cpus().length },
  node: process.version,
  artifacts,
  phases: [],
  startedAt: new Date(startedAt).toISOString(),
  status: "RUNNING",
};
const owned = { processes: [], tempDirs: [], servers: [] };
let shuttingDown = false;

function log(message) {
  const line = `[qa-feed-inline] ${message}`;
  console.log(line);
  fs.appendFileSync(path.join(artifacts, "orchestrator.log"), `${line}\n`);
}

function blocker(message) {
  state.status = "BLOCKED";
  state.blocker = message;
  log(`BLOCKED: ${message}`);
  persist();
  console.log(`\nArtifacts: ${artifacts}`);
  process.exit(2);
}

function persist() {
  state.elapsedMs = Date.now() - startedAt;
  state.tthw = {
    commands: 1,
    wallClockSeconds: Math.round(state.elapsedMs / 1000),
    note: "Single-command automation wall time from the documented prerequisite state. Human reading/comprehension is not separately timed.",
  };
  fs.writeFileSync(path.join(artifacts, "summary.json"), `${JSON.stringify(state, null, 2)}\n`);
}

function hasBinary(name) {
  const result = spawnSync(name, ["--version"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") return null;
  if (result.error) return null;
  return String(result.stdout || result.stderr).split("\n")[0];
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function mustRun(label, command, args, options = {}) {
  const result = await run(command, args, options);
  fs.writeFileSync(path.join(artifacts, `${label}.log`),
    `$ ${command} ${args.join(" ")}\n\n${result.stdout}\n${result.stderr}`);
  if (result.code !== 0) {
    log(`${label} failed (exit ${result.code})`);
    process.stderr.write(result.stderr.slice(-4000));
    throw new Error(`${label} failed`);
  }
  return result;
}

const GUARD = String.raw`
const net = require("node:net");
const original = net.Socket.prototype.connect;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "::", undefined, null]);
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  if (first && typeof first === "object" && typeof first.path === "string") {
    return original.apply(this, args); // unix domain socket
  }
  let host;
  if (first && typeof first === "object") host = first.host;
  else if (typeof first === "number") host = args[1];
  if (!LOOPBACK.has(host)) {
    const line = "QA_EGRESS_BLOCKED host=" + String(host) + "\n";
    process.stderr.write(line);
    throw new Error("QA egress guard blocked non-loopback connection");
  }
  return original.apply(this, args);
};
process.stderr.write("QA_EGRESS_GUARD_READY\n");
`;

function baseEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: os.tmpdir(),
    LANG: "en_US.UTF-8",
    SHELL: "/bin/zsh",
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_OPTIONS: `--require ${extra.guard}`,
    ...extra,
  };
}

// Every key a child of this harness may receive. An allowlist is what keeps an
// inherited production credential out: a denylist only covers the names someone
// remembered, and `baseEnv` is spread from an object built by hand.
const ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "TMPDIR", "LANG", "SHELL", "NODE_ENV", "NEXT_TELEMETRY_DISABLED",
  "NODE_OPTIONS", "guard", "DATABASE_URL", "AUTH_SECRET", "AUTH_URL", "NEXTAUTH_URL",
  "NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_APP_NAME", "FEED_INLINE_REPLIES",
  "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL",
]);

function assertSafeEnv(env) {
  // The child env is built from scratch; assert it rather than trusting a filter.
  for (const key of Object.keys(env)) {
    assert.ok(ENV_ALLOWLIST.has(key), `unexpected env key passed to a child process: ${key}`);
  }
  for (const key of Object.keys(env)) {
    if (/(_API_KEY|SECRET|TOKEN|PASSWORD)$/i.test(key)) {
      assert.ok(
        ["AUTH_SECRET", "DEEPSEEK_API_KEY"].includes(key),
        `unexpected credential-like env key: ${key}`,
      );
    }
  }
  assert.ok(!("ARK_API_KEY" in env));
  assert.ok(!("GLM_API_KEY" in env));
  assert.ok(!("KIMI_API_KEY" in env));
  assert.ok(!("MINIMAX_API_KEY" in env));
  assert.ok(env.DATABASE_URL.includes("127.0.0.1"));
}

async function copyStaging(root) {
  const staging = path.join(root, "staging");
  fs.mkdirSync(staging, { recursive: true });
  for (const dir of ["app", "components", "i18n", "lib"]) {
    fs.cpSync(path.join(REPO, "src", dir), path.join(staging, "src", dir), { recursive: true });
  }
  fs.cpSync(path.join(REPO, "src", "proxy.ts"), path.join(staging, "src", "proxy.ts"));
  fs.mkdirSync(path.join(staging, "src", "generated"), { recursive: true });
  fs.symlinkSync(path.join(REPO, "src", "generated", "prisma"),
    path.join(staging, "src", "generated", "prisma"));
  fs.cpSync(path.join(REPO, "prisma"), path.join(staging, "prisma"), { recursive: true });
  for (const file of ["next.config.ts", "package.json", "tsconfig.json",
    "postcss.config.mjs", "next-env.d.ts"]) {
    fs.cpSync(path.join(REPO, file), path.join(staging, file));
  }
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(staging, "node_modules"));
  fs.mkdirSync(path.join(staging, "public"));
  const leaked = fs.readdirSync(staging).filter((name) => name.startsWith(".env"));
  assert.deepEqual(leaked, [], "staging tree must not contain .env*");
  return staging;
}

function startLogged(label, command, args, options) {
  const logPath = path.join(artifacts, `${label}.log`);
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  owned.processes.push({ label, child, logPath });
  return child;
}

async function waitHttp(url, { timeoutMs = 180_000, headers = {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
      const body = await response.text();
      if (response.status === 200) return { response, body };
      last = `${response.status} ${body.slice(0, 300)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${url}: ${last}`);
}

async function stopChildren() {
  // Take the list once: a second splice(0) would hand the SIGKILL pass an empty
  // array, leaving children that ignored SIGTERM running after cleanup.
  const children = owned.processes.splice(0);
  for (const entry of children) {
    if (entry.child.exitCode === null && entry.child.signalCode === null) {
      try { process.kill(-entry.child.pid, "SIGTERM"); } catch {}
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 700));
  for (const entry of children) {
    if (entry.child.exitCode === null && entry.child.signalCode === null) {
      try { process.kill(-entry.child.pid, "SIGKILL"); } catch {}
    }
  }
}

async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopChildren();
  for (const server of owned.servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
  for (const dir of owned.tempDirs.splice(0)) {
    if (fs.existsSync(path.join(dir, "pgdata"))) {
      await run("pg_ctl", ["-D", path.join(dir, "pgdata"), "-m", "immediate", "stop"]);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    state.status = "ABORTED";
    persist();
    await cleanup();
    process.exit(130);
  });
}

function startModerationDouble() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
        res.writeHead(404).end("not found");
        return;
      }
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        let text = "";
        try {
          const body = JSON.parse(raw);
          text = (body.messages ?? []).map((m) => String(m.content ?? "")).join("\n");
        } catch { text = raw; }
        // [qa:reject] is handled by the seeded local-keyword layer. The AI
        // double only covers publish and pending_review, matching screenContent.
        const verdict = text.includes("[qa:pending]")
          ? { category: "normal", confidence: 0.2, reason: "qa pending" }
          : { category: "normal", confidence: 0.99, reason: "qa publish" };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "qa-double",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "qa-double",
          choices: [{
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(verdict) },
          }],
        }));
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      owned.servers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}/v1`);
    });
  });
}

async function startPhase({ staging, gate, port, databaseUrl, doubleUrl, guard }) {
  const env = baseEnv({
    guard,
    DATABASE_URL: databaseUrl,
    AUTH_SECRET: "qa-only-secret-not-for-production-0123456789abcdef",
    AUTH_URL: `http://127.0.0.1:${port}`,
    NEXTAUTH_URL: `http://127.0.0.1:${port}`,
    NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${port}`,
    NEXT_PUBLIC_APP_NAME: "Puer QA",
    FEED_INLINE_REPLIES: gate,
    DEEPSEEK_API_KEY: "qa-only-key",
    DEEPSEEK_BASE_URL: doubleUrl,
  });
  assertSafeEnv(env);
  const child = startLogged(`dev-gate-${gate}`,
    path.join(staging, "node_modules", ".bin", "next"),
    ["dev", "--webpack", "-p", String(port), "-H", "127.0.0.1"],
    { cwd: staging, env });
  child.on("exit", (code) => {
    if (!shuttingDown && code !== 0 && code !== null) {
      log(`dev server for gate=${gate} exited early with ${code}; see dev-gate-${gate}.log`);
    }
  });
  return env;
}

async function runBrowser({ mode, baseUrl, viewer }) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    QA_BASE_URL: baseUrl,
    QA_MODE: mode,
    QA_ARTIFACTS: artifacts,
    QA_VIEWER_EMAIL: viewer.email,
    QA_VIEWER_PASSWORD: viewer.password,
    QA_VIEWER_USERNAME: viewer.username,
  };
  const result = await mustRun(`browser-${mode}`, process.execPath,
    [path.join(REPO, "scripts", "qa-feed-inline-browser.mjs")], { cwd: REPO, env });
  process.stdout.write(result.stdout);
  return result;
}

async function main() {
  const pgVersion = hasBinary("initdb");
  const pgCtlVersion = hasBinary("pg_ctl");
  const psqlVersion = hasBinary("psql");
  if (!pgVersion || !pgCtlVersion || !psqlVersion) {
    blocker("PostgreSQL 16 binaries not found. On macOS: brew install postgresql@16 && brew link --force postgresql@16");
  }
  state.postgres = { initdb: pgVersion, pg_ctl: pgCtlVersion, psql: psqlVersion };
  if (!pgVersion.startsWith("initdb (PostgreSQL) 16")) {
    blocker(`PostgreSQL 16 is required, found: ${pgVersion}`);
  }
  if (!fs.existsSync(chromium.executablePath())) {
    blocker(`Playwright Chromium not installed. Run: npx playwright install chromium`);
  }
  if (!fs.existsSync(path.join(REPO, "src", "generated", "prisma", "client.js"))) {
    blocker("Prisma client not generated. Run: npx prisma generate");
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "puer-feed-inline-qa-"));
  owned.tempDirs.push(root);
  log(`temp root: ${root}`);
  const guard = path.join(root, "egress-guard.cjs");
  fs.writeFileSync(guard, GUARD);

  const staging = await copyStaging(root);
  log(`staging tree: ${staging} (no .env*, symlinked node_modules)`);

  const pgdata = path.join(root, "pgdata");
  const pgport = await freePort();
  const dbName = "puer_qa";
  const dbUser = "puer_qa";
  const databaseUrl = `postgresql://${dbUser}@127.0.0.1:${pgport}/${dbName}`;

  await mustRun("initdb", "initdb", [
    "-D", pgdata, "-U", dbUser, "--auth=trust", "--no-locale", "-E", "UTF8", "-T", "template0",
  ]);
  await mustRun("pg-start", "pg_ctl", [
    "-D", pgdata, "-o", `-p ${pgport} -c listen_addresses=127.0.0.1`,
    "-l", path.join(artifacts, "postgres.log"), "-w", "start",
  ]);
  await mustRun("createdb", "createdb", [
    "-h", "127.0.0.1", "-p", String(pgport), "-U", dbUser, "-T", "template0", dbName,
  ]);
  await mustRun("schema", path.join(staging, "node_modules", ".bin", "prisma"),
    ["db", "push", "--schema", "prisma/schema.prisma", "--skip-generate", "--accept-data-loss"],
    { cwd: staging, env: baseEnv({ guard, DATABASE_URL: databaseUrl }) });

  const seedResult = await mustRun("seed", process.execPath,
    [path.join(REPO, "scripts", "qa-feed-inline-seed.mjs")],
    { cwd: REPO, env: baseEnv({ guard, DATABASE_URL: databaseUrl }) });
  const seedLine = seedResult.stdout.trim().split("\n").filter((line) => line.startsWith("{")).at(-1);
  if (!seedLine) blocker("QA seed produced no fixture summary; see seed.log");
  const seed = JSON.parse(seedLine);
  state.seed = { articles: seed.articles, comments: seed.comments };
  const viewer = seed.viewer;

  const doubleUrl = await startModerationDouble();
  log(`moderation double: loopback only (${doubleUrl.replace(/:\d+\//, ":<port>/")})`);

  // Phase 1: gate OFF. Old cards, no comment fields, feed surface 404.
  const offPort = await freePort();
  await startPhase({ staging, gate: "0", port: offPort, databaseUrl, doubleUrl, guard });
  const offBase = `http://127.0.0.1:${offPort}`;
  await waitHttp(`${offBase}/forum`);
  const offLog = fs.readFileSync(path.join(artifacts, "dev-gate-0.log"), "utf8");
  if (!offLog.includes("QA_EGRESS_GUARD_READY")) {
    blocker("egress guard did not load in the dev server; browser QA is blocked, not mocked");
  }
  state.phases.push({ gate: "off", baseUrl: offBase });
  await runBrowser({ mode: "off", baseUrl: offBase, viewer });
  log("gate-off phase passed");
  await stopChildren();

  // Phase 2: gate ON. Full browser matrix.
  const onPort = await freePort();
  await startPhase({ staging, gate: "1", port: onPort, databaseUrl, doubleUrl, guard });
  const onBase = `http://127.0.0.1:${onPort}`;
  await waitHttp(`${onBase}/forum`);
  const onLog = fs.readFileSync(path.join(artifacts, "dev-gate-1.log"), "utf8");
  if (!onLog.includes("QA_EGRESS_GUARD_READY")) {
    blocker("egress guard did not load in the dev server; browser QA is blocked, not mocked");
  }
  state.phases.push({ gate: "on", baseUrl: onBase });
  await runBrowser({ mode: "on", baseUrl: onBase, viewer });
  log("gate-on phase passed");

  const allLogs = ["dev-gate-0.log", "dev-gate-1.log"]
    .map((name) => fs.existsSync(path.join(artifacts, name))
      ? fs.readFileSync(path.join(artifacts, name), "utf8") : "").join("\n");
  const blocked = allLogs.split("\n").filter((line) => line.includes("QA_EGRESS_BLOCKED"));
  if (blocked.length) {
    fs.writeFileSync(path.join(artifacts, "egress-blocked.log"), blocked.join("\n"));
    // Next's webpack dev overlay unconditionally probes the npm dist-tags
    // endpoint for its version badge. The guard stops it; no application data
    // is sent. Any other attempted host is a real isolation failure.
    const unexpected = blocked.filter((line) => !line.includes("host=registry.npmjs.org"));
    state.egress = {
      blockedAttempts: blocked.length,
      nextDevVersionProbe: blocked.length - unexpected.length,
      unexpectedHosts: unexpected,
    };
    if (unexpected.length) {
      throw new Error(`egress guard blocked ${unexpected.length} unexpected non-loopback connection(s)`);
    }
  }

  state.status = "PASS";
  persist();
  log(`PASS in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  console.log(`\nArtifacts: ${artifacts}`);
}

main()
  .catch((error) => {
    state.status = "FAIL";
    state.error = error instanceof Error ? error.message : String(error);
    persist();
    log(`FAIL: ${state.error}`);
    console.log(`\nArtifacts: ${artifacts}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
