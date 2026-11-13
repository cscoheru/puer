#!/usr/bin/env node

/**
 * llm-provider-probe.mjs — 探测当前配了 key 的 LLM 供应商谁能正常返回。
 *
 * 背景：主力供应商额度打满/欠费时（MiniMax 已停服；DeepSeek 402/429、
 * Ark 套餐限流），回填管线必须知道此刻还能切到谁。报告只证明「该 key 此刻
 * 能正常返回」，不评估质量。
 *
 * 2026-11-12：供应商清单不再在本文件手抄 —— 直接消费 scripts/lib/llm.mjs 的
 * targets() 与 buildChatBody()，新增/下线供应商只改参考实现一处（R30 纪律：
 * 探针手抄的 temperature 漏了 Ark 的 0.6 限制就会报假警）。
 *
 * Run:
 *   node scripts/llm-provider-probe.mjs
 */

import { targets, buildChatBody } from "./lib/llm.mjs";

const chain = targets();
if (!chain.length) {
  console.error("没有配置任何 LLM key（DEEPSEEK_API_KEY / ARK_API_KEY）");
  process.exit(1);
}

for (const t of chain) {
  const label = t.id.padEnd(9);
  try {
    const res = await fetch(t.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${t.apiKey}`,
      },
      // 每个 target 的 temperature（Ark 固定 0.6）与 jsonMode 都在统一构造里。
      body: JSON.stringify(
        buildChatBody(t, [{ role: "user", content: "回复ok" }], { maxTokens: 8 }),
      ),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (res.ok) {
      console.log(`${label} ✅ ${res.status}  ${text.slice(0, 80).replace(/\s+/g, " ")}`);
    } else {
      console.log(`${label} ❌ ${res.status}  ${text.slice(0, 160).replace(/\s+/g, " ")}`);
    }
  } catch (e) {
    console.log(`${label} ❌ 网络/超时  ${e.message} ${e.cause?.code ?? ""}`);
  }
}
