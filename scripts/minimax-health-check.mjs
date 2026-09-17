#!/usr/bin/env node

/**
 * minimax-health-check.mjs — R28e MiniMax 余额健康探针
 *
 * 每小时调一次 MiniMax API(最低 token 消耗),根据 HTTP 状态写心跳或告警:
 *   200           → [HEARTBEAT] 写 minimax-health.log(健康)
 *   402           → [ALERT] 余额不足,写 health-alerts.log(关键告警)
 *   其他 4xx/5xx  → [ALERT] API 异常,写 health-alerts.log
 *
 * 24h 内同型告警只发一次,避免每小时 spam(由 minimax-alert-state.json 记录
 * 上次告警时间和类型;状态恢复 OK 时自动重置)。
 *
 * 日志:
 *   健康心跳: /opt/puer-hub/backups/minimax-health.log  (每次跑都写一行)
 *   告警:     /opt/puer-hub/backups/health-alerts.log    (与 site-down 告警同入口)
 *
 * Run (host crontab):
 *   0 * * * * cd /opt/puer-hub && scripts/cron-task.sh minimax-health >> /var/log/minimax-health.log 2>&1
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import {
  MINIMAX_API_KEY, log,
} from "./lib/post-helpers.mjs";

const MINIMAX_BASE = "https://api.minimax.cn/v1/chat/completions";
const MINIMAX_MODEL = "MiniMax-M3";
const HEARTBEAT_LOG = "/opt/puer-hub/backups/minimax-health.log";
const ALERT_LOG = "/opt/puer-hub/backups/health-alerts.log";
const STATE_FILE = "/opt/puer-hub/backups/minimax-alert-state.json";
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

if (!MINIMAX_API_KEY) {
  console.error("ERROR: MINIMAX_API_KEY not set");
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
    log(`minimax-health: failed to write state: ${e.message}`);
  }
}

function shouldAlert(state, alertType) {
  if (state.lastAlertType !== alertType) return true; // 类型变了 (e.g. 402 → ok → 402)
  return Date.now() - state.lastAlertAt > DEDUPE_WINDOW_MS;
}

async function probe() {
  const res = await fetch(MINIMAX_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MINIMAX_API_KEY}` },
    body: JSON.stringify({
      model: MINIMAX_MODEL,
      messages: [{ role: "user", content: "ping" }],
      max_completion_tokens: 1,
      thinking: { type: "disabled" },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text().catch(() => "");
  return { status: res.status, body };
}

function classify(status) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401) return "auth_error";
  if (status === 402) return "insufficient_balance";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "api_down";
  return `http_${status}`;
}

async function main() {
  const ts = new Date().toISOString();
  let result;
  try {
    result = await probe();
  } catch (e) {
    // 网络/超时: API 域名不可达 — 写 ALERT,不分类为余额
    log(`probe failed: ${e.message}`);
    const state = readState();
    const alertType = "network_error";
    if (shouldAlert(state, alertType)) {
      const line = `[ALERT] MiniMax unreachable at ${ts}: ${e.message.slice(0, 120)}\n`;
      appendFileSync(ALERT_LOG, line);
      writeState({ lastAlertAt: Date.now(), lastAlertType: alertType });
    }
    process.exit(1);
  }

  const cls = classify(result.status);
  const state = readState();

  if (cls === "ok") {
    // 健康:写心跳 + 状态变化时打印恢复
    const heartbeat = `[HEARTBEAT] MiniMax ok at ${ts} status=${result.status}\n`;
    appendFileSync(HEARTBEAT_LOG, heartbeat);
    if (state.lastAlertType && state.lastAlertType !== "ok") {
      const recovery = `[RECOVERED] MiniMax back to normal at ${ts} (prev=${state.lastAlertType})\n`;
      appendFileSync(ALERT_LOG, recovery);
    }
    writeState({ lastAlertAt: 0, lastAlertType: "ok" });
    log(`MiniMax ok status=${result.status}`);
    process.exit(0);
  }

  // 异常: 写 ALERT(去重)
  if (shouldAlert(state, cls)) {
    const detail = result.body.length > 0 ? result.body.slice(0, 200) : "(no body)";
    const line = `[ALERT] MiniMax ${cls} at ${ts} status=${result.status} body=${detail.replace(/\n/g, " ")}\n`;
    appendFileSync(ALERT_LOG, line);
    writeState({ lastAlertAt: Date.now(), lastAlertType: cls });
    log(`MiniMax ${cls} status=${result.status} → ALERT (first time or 24h passed)`);
  } else {
    log(`MiniMax ${cls} status=${result.status} → suppressed (last alert ${Math.round((Date.now() - state.lastAlertAt) / 3600000)}h ago)`);
  }
  process.exit(cls === "insufficient_balance" ? 2 : 1);
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});