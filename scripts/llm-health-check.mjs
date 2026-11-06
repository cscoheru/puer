#!/usr/bin/env node

/**
 * llm-health-check.mjs — LLM 供应商健康探针（2026-11-06，取代 minimax-health-check）
 *
 * 每小时各调一次最低 token 的探针，按状态写心跳或告警：
 *
 *   主力 = DeepSeek（DEEPSEEK_API_KEY）
 *   兜底 = GLM（GLM_API_KEY）
 *
 *   两家都 200                    → [HEARTBEAT] ok
 *   DeepSeek 失败、GLM 200        → [HEARTBEAT] fallback（说明主力降级了，但管线还活着）
 *   两家都失败                    → [ALERT]（24h 内同型只记一次）
 *
 * DeepSeek 的 402（Insufficient Balance）单独分类成 `insufficient_balance`：
 * 那是欠费，重试不会好，必须充值或切兜底。
 *
 * 日志:
 *   健康心跳: /opt/puer-hub/backups/llm-health.log      （每次跑都写一行）
 *   告警:     /opt/puer-hub/backups/health-alerts.log    （与 site-down 告警同入口）
 *   去重状态: /opt/puer-hub/backups/llm-alert-state.json
 *
 * Run (host crontab):
 *   0 * * * * cd /opt/puer-hub && scripts/cron-task.sh llm-health >> /var/log/llm-health.log 2>&1
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { DEEPSEEK_API_KEY, DEEPSEEK_CHAT_URL, DEEPSEEK_MODEL } from "./lib/llm.mjs";
import { log } from "./lib/post-helpers.mjs";

const HEARTBEAT_LOG = "/opt/puer-hub/backups/llm-health.log";
const ALERT_LOG = "/opt/puer-hub/backups/health-alerts.log";
const STATE_FILE = "/opt/puer-hub/backups/llm-alert-state.json";
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

const GLM_KEY = process.env.GLM_API_KEY;
const GLM_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const GLM_MODEL = process.env.GLM_MODEL || "glm-4-flash";

if (!DEEPSEEK_API_KEY && !GLM_KEY) {
  console.error("ERROR: DEEPSEEK_API_KEY / GLM_API_KEY 均未设置");
  process.exit(1);
}

function readState() {
  if (!existsSync(STATE_FILE)) return { lastAlertAt: 0, lastAlertType: null };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastAlertAt: 0, lastAlertType: null };
  }
}

function writeState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    log(`llm-health: failed to write state: ${e.message}`);
  }
}

function shouldAlert(state, alertType) {
  if (state.lastAlertType !== alertType) return true; // 类型变了
  return Date.now() - state.lastAlertAt > DEDUPE_WINDOW_MS;
}

async function probe(url, model, key) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text().catch(() => "");
  return { status: res.status, body };
}

function classify(status, body) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "auth_error";
  if (status === 429) return "rate_limit";
  if (status === 402) return "insufficient_balance"; // DeepSeek 欠费，重试不会好
  if (status >= 500) return "api_down";
  return `http_${status}`;
}

async function tryOne(label, url, model, key) {
  if (!key) return { label, cls: "no_key", status: 0, body: "key not set" };
  try {
    const r = await probe(url, model, key);
    return { label, cls: classify(r.status, r.body), status: r.status, body: r.body };
  } catch (e) {
    return { label, cls: "network_error", status: 0, body: e.message };
  }
}

async function main() {
  const ts = new Date().toISOString();
  const primary = await tryOne("deepseek", DEEPSEEK_CHAT_URL, DEEPSEEK_MODEL, DEEPSEEK_API_KEY);

  if (primary.cls === "ok") {
    appendFileSync(HEARTBEAT_LOG, `[HEARTBEAT] deepseek ok at ${ts}\n`);
    const state = readState();
    if (state.lastAlertType && state.lastAlertType !== "ok") {
      appendFileSync(ALERT_LOG, `[RECOVERED] deepseek back to normal at ${ts} (prev=${state.lastAlertType})\n`);
    }
    writeState({ lastAlertAt: 0, lastAlertType: "ok" });
    log(`deepseek ok`);
    process.exit(0);
  }

  // 主力不行 → 看兜底。兜底健康时只写心跳，不刷告警（管线仍然可用）。
  const glm = await tryOne("glm", GLM_URL, GLM_MODEL, GLM_KEY);
  if (glm.cls === "ok") {
    appendFileSync(
      HEARTBEAT_LOG,
      `[HEARTBEAT] fallback at ${ts} deepseek=${primary.cls} status=${primary.status} → glm ok\n`,
    );
    log(`deepseek ${primary.cls} (${primary.status}) → glm ok, pipeline alive`);
    process.exit(0);
  }

  const alertType = `${primary.cls}+${glm.cls}`;
  const state = readState();
  if (shouldAlert(state, alertType)) {
    const detail = `deepseek=${primary.cls}/${primary.status} ${primary.body.slice(0, 120)} | glm=${glm.cls}/${glm.status} ${glm.body.slice(0, 80)}`;
    appendFileSync(ALERT_LOG, `[ALERT] LLM all down at ${ts} ${detail.replace(/\n/g, " ")}\n`);
    writeState({ lastAlertAt: Date.now(), lastAlertType: alertType });
    log(`all providers down (${alertType}) → ALERT`);
  } else {
    log(`all providers down (${alertType}) → suppressed (last alert ${Math.round((Date.now() - state.lastAlertAt) / 3600000)}h ago)`);
  }
  process.exit(primary.cls === "insufficient_balance" ? 2 : 1);
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
