#!/usr/bin/env node

/**
 * llm-health-check.mjs — LLM 供应商健康探针（2026-11-06 取代 minimax-health-check；
 * 2026-11-12 加入火山方舟 Agent Plan，心跳覆盖 DeepSeek/Ark 两家）
 *
 * 每小时对**当前配了 key 的整条链**各发一次最低 token 探针，链与请求体全部
 * 来自 `scripts/lib/llm.mjs` 的 targets()/buildChatBody() —— 探针不许手抄
 * URL/模型/temperature（Ark 只接受 0.6，手抄漏了就是假告警）。
 *
 *   DeepSeek 200                       → [HEARTBEAT] ok
 *   DeepSeek 失败、Ark 200             → [HEARTBEAT] fallback（主力降级了，但管线活着）
 *   主力 ok 但另一配 key 的 target 挂了 → [ALERT] fallback degraded（24h 同型去重，退出码仍 0）
 *   配了 key 的供应商全失败            → [ALERT]（24h 内同型只记一次）
 *
 * 402（Insufficient Balance）单独分类成 `insufficient_balance`：
 * 欠费重试不会好，必须充值或切兜底；这种情况退出码 2，其余全灭退出码 1。
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
import { targets, buildChatBody } from "./lib/llm.mjs";
import { log } from "./lib/post-helpers.mjs";

const HEARTBEAT_LOG = "/opt/puer-hub/backups/llm-health.log";
const ALERT_LOG = "/opt/puer-hub/backups/health-alerts.log";
const STATE_FILE = "/opt/puer-hub/backups/llm-alert-state.json";
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

const chain = targets();
if (!chain.length) {
  console.error("ERROR: DEEPSEEK_API_KEY / ARK_API_KEY 均未设置");
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

async function probe(target) {
  const res = await fetch(target.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${target.apiKey}`,
    },
    // 走统一构造：Ark target 的 temperature 0.6 与 jsonMode=false 在这里生效，
    // max_tokens=1 只是心跳，不关心返回内容。
    body: JSON.stringify(
      buildChatBody(target, [{ role: "user", content: "ping" }], { maxTokens: 1 }),
    ),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text().catch(() => "");
  return { status: res.status, body };
}

function classify(status, body) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "auth_error";
  if (status === 429) return "rate_limit";
  if (status === 402) return "insufficient_balance"; // 欠费，重试不会好
  if (status >= 500) return "api_down";
  return `http_${status}`;
}

async function tryOne(target) {
  try {
    const r = await probe(target);
    return { label: target.id, cls: classify(r.status, r.body), status: r.status, body: r.body };
  } catch (e) {
    return { label: target.id, cls: "network_error", status: 0, body: e.message };
  }
}

async function main() {
  const ts = new Date().toISOString();
  const results = [];
  for (const t of chain) {
    results.push(await tryOne(t));
  }

  const byId = Object.fromEntries(results.map((r) => [r.label, r]));
  const primary = byId.deepseek;
  const firstHealthy = results.find((r) => r.cls === "ok");

  // 1) 链上至少一家健康（主力 DeepSeek 优先；没配 DS 时就是链上第一家）。
  // 心跳标签必须写实际健康的 target id —— Ark-only 配置打 "deepseek ok" 是假日志。
  const healthy = primary?.cls === "ok" ? primary : firstHealthy;
  if (healthy) {
    appendFileSync(HEARTBEAT_LOG, `[HEARTBEAT] ${healthy.label} ok at ${ts}\n`);
    const state = readState();
    if (state.lastAlertType && state.lastAlertType !== "ok") {
      appendFileSync(
        ALERT_LOG,
        `[RECOVERED] ${healthy.label} back to normal at ${ts} (prev=${state.lastAlertType})\n`,
      );
    }
    // 主力活着但其他配了 key 的 target 挂了：兜底要到 DeepSeek 配额耗尽那天才
    // 第一次被用，那时才发现 key 失效就晚了（R26.3：静默降级 = 延迟爆炸）。
    // 按类型 24h 去重写告警；管线本身健康，退出码仍为 0。
    const degraded = results.filter(
      (r) => r.label !== healthy.label && r.cls !== "ok",
    );
    if (degraded.length) {
      const warnType =
        "degraded:" + degraded.map((d) => `${d.label}:${d.cls}`).join("+");
      const due =
        state.lastDegradedType !== warnType ||
        Date.now() - (state.lastDegradedAt ?? 0) > DEDUPE_WINDOW_MS;
      if (due) {
        const detail = degraded
          .map((d) => `${d.label}=${d.cls}/${d.status} ${d.body.slice(0, 100)}`)
          .join(" | ");
        appendFileSync(
          ALERT_LOG,
          `[ALERT] LLM fallback degraded at ${ts} ${detail.replace(/\n/g, " ")}\n`,
        );
        state.lastDegradedAt = Date.now();
        state.lastDegradedType = warnType;
      }
      log(`fallback degraded: ${warnType}`);
    }
    // 保留 degraded 去重字段，只复位全灭告警状态。
    writeState({ ...state, lastAlertAt: 0, lastAlertType: "ok" });
    log(`${healthy.label} ok`);
    process.exit(0);
  }

  // 2) 主力不行 → 链上另一家健康就是 fallback，管线还活着，只写心跳不刷告警。
  if (firstHealthy) {
    const failedDs = primary
      ? `deepseek=${primary.cls} status=${primary.status}`
      : "deepseek=no_key";
    appendFileSync(
      HEARTBEAT_LOG,
      `[HEARTBEAT] fallback at ${ts} ${failedDs} → ${firstHealthy.label} ok\n`,
    );
    log(`${failedDs} → ${firstHealthy.label} ok, pipeline alive`);
    process.exit(0);
  }

  // 3) 配了 key 的供应商全灭 → 告警（24h 同型去重）。
  const alertType = results.map((r) => `${r.label}:${r.cls}`).join("+");
  const state = readState();
  if (shouldAlert(state, alertType)) {
    const detail = results
      .map((r) => `${r.label}=${r.cls}/${r.status} ${r.body.slice(0, 100)}`)
      .join(" | ");
    appendFileSync(
      ALERT_LOG,
      `[ALERT] LLM all down at ${ts} ${detail.replace(/\n/g, " ")}\n`,
    );
    writeState({ lastAlertAt: Date.now(), lastAlertType: alertType });
    log(`all providers down (${alertType}) → ALERT`);
  } else {
    log(
      `all providers down (${alertType}) → suppressed (last alert ${Math.round(
        (Date.now() - state.lastAlertAt) / 3600000,
      )}h ago)`,
    );
  }
  const anyInsufficientBalance = results.some((r) => r.cls === "insufficient_balance");
  process.exit(anyInsufficientBalance ? 2 : 1);
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
