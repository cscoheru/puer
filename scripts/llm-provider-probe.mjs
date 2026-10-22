#!/usr/bin/env node

/**
 * llm-provider-probe.mjs — 探测哪个 LLM 供应商当前可用（只发 5 token 的问候）。
 *
 * 背景：MiniMax 配额耗尽（429/2056）时，回填管线必须知道能不能切到别家。
 * 报告只证明「该 key 此刻能正常返回」，不评估质量。
 *
 * Run:
 *   node scripts/llm-provider-probe.mjs
 */

const PROVIDERS = [
  {
    name: "minimax",
    env: "MINIMAX_API_KEY",
    url: "https://api.minimax.cn/v1/chat/completions",
    model: "MiniMax-M3",
    maxKey: "max_completion_tokens",
    extra: { thinking: { type: "disabled" } },
  },
  {
    name: "deepseek",
    env: "DEEPSEEK_API_KEY",
    url: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-chat",
    maxKey: "max_tokens",
  },
  {
    name: "glm",
    env: "GLM_API_KEY",
    url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4-flash",
    maxKey: "max_tokens",
  },
  {
    name: "kimi",
    env: "KIMI_API_KEY",
    url: "https://api.moonshot.cn/v1/chat/completions",
    model: "moonshot-v1-8k",
    maxKey: "max_tokens",
  },
];

for (const p of PROVIDERS) {
  const key = process.env[p.env];
  if (!key) {
    console.log(`${p.name.padEnd(9)} 跳过（${p.env} 未设置）`);
    continue;
  }
  try {
    const res = await fetch(p.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: "user", content: "回复ok" }],
        temperature: 0,
        [p.maxKey]: 8,
        ...(p.extra ?? {}),
      }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    if (res.ok) {
      console.log(`${p.name.padEnd(9)} ✅ ${res.status}  ${text.slice(0, 80).replace(/\s+/g, " ")}`);
    } else {
      console.log(`${p.name.padEnd(9)} ❌ ${res.status}  ${text.slice(0, 160).replace(/\s+/g, " ")}`);
    }
  } catch (e) {
    console.log(`${p.name.padEnd(9)} ❌ 网络/超时  ${e.message} ${e.cause?.code ?? ""}`);
  }
}
