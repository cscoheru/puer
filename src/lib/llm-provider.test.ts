import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callLLM,
  arkAgentPlanTarget,
  deepseekTarget,
  chatTargetChain,
  chatFallbackTargets,
  buildChatBody,
  targetLabel,
  type LLMTarget,
} from "./llm-provider.ts";

const target = (id: string): LLMTarget => ({
  id,
  url: `http://${id}.test/chat`,
  model: "m",
  maxKey: "max_tokens",
  apiKey: "k",
});

/** 替换全局 fetch，返回一段脚本化响应序列。 */
function stubFetch(responses: (() => Response)[]) {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async () => {
    const make = responses[Math.min(i, responses.length - 1)];
    i++;
    return make();
  }) as typeof globalThis.fetch;
  return {
    calls: () => i,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const ok = (content: string) =>
  () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

const fail = (status: number, body = "err") =>
  () =>
    new Response(body, { status });

test("成功：返回解析后的 JSON 与供应商 id", async () => {
  const s = stubFetch([ok('{"a":1}')]);
  try {
    const r = await callLLM(target("t1"), "p", { retries: 0 });
    assert.deepEqual(r.content, { a: 1 });
    assert.equal(r.source, "t1");
    assert.equal(s.calls(), 1);
  } finally {
    s.restore();
  }
});

test("配额类错误：原地重试后成功", async () => {
  const s = stubFetch([fail(429, "quota exceeded"), ok('{"ok":true}')]);
  try {
    const r = await callLLM(target("t1"), "p", { retries: 1, backoffMs: [1] });
    assert.deepEqual(r.content, { ok: true });
    assert.equal(s.calls(), 2, "配额错误应重试");
  } finally {
    s.restore();
  }
});

test("配额错误耗尽重试：降级到备用供应商", async () => {
  const s = stubFetch([fail(429), fail(429), ok('{"from":"backup"}')]);
  try {
    const r = await callLLM(target("t1"), "p", {
      retries: 1,
      backoffMs: [1],
      fallbacks: [target("t2")],
    });
    assert.equal(r.source, "t2");
    assert.deepEqual(r.content, { from: "backup" });
  } finally {
    s.restore();
  }
});

test("鉴权错误：立即失败，不重试也不降级", async () => {
  const s = stubFetch([fail(401, "unauthorized")]);
  try {
    await assert.rejects(
      () => callLLM(target("t1"), "p", { retries: 3, backoffMs: [1], fallbacks: [target("t2")] }),
      /401/,
    );
    assert.equal(s.calls(), 1, "鉴权错误不该重试");
  } finally {
    s.restore();
  }
});

test("全部供应商都不可用：报错里带上每家的原因", async () => {
  const s = stubFetch([fail(429, "quota")]);
  try {
    await assert.rejects(
      () => callLLM(target("t1"), "p", { retries: 0, fallbacks: [target("t2")] }),
      /所有 LLM 供应商都不可用/,
    );
  } finally {
    s.restore();
  }
});

test("返回的不是 JSON：直接报错", async () => {
  const s = stubFetch([ok("这不是 JSON")]);
  try {
    await assert.rejects(() => callLLM(target("t1"), "p", { retries: 0 }), /不是 JSON/);
  } finally {
    s.restore();
  }
});

test("没有 key 的目标直接跳过，不发请求", async () => {
  const s = stubFetch([ok("{}")]);
  try {
    const noKey = { ...target("t1"), apiKey: undefined };
    await assert.rejects(
      () => callLLM(noKey, "p", { retries: 0 }),
      /未配置 key/,
    );
    assert.equal(s.calls(), 0);
  } finally {
    s.restore();
  }
});

test("供应商 5xx：算可重试，耗尽后降级到备用", async () => {
  const s = stubFetch([fail(503, "upstream down"), ok('{"from":"backup"}')]);
  try {
    const r = await callLLM(target("t1"), "p", {
      retries: 0,
      fallbacks: [target("t2")],
    });
    assert.equal(r.source, "t2");
    assert.deepEqual(r.content, { from: "backup" });
    assert.equal(s.calls(), 2);
  } finally {
    s.restore();
  }
});

// ─── 火山方舟 Agent Plan（2026-11-12 接入）────────────────────────────────

test("arkAgentPlanTarget：Agent Plan lane 的 URL / 温度 / jsonMode 形状", () => {
  const ark = arkAgentPlanTarget("ark-key");
  assert.equal(ark.id, "ark");
  assert.equal(
    ark.url,
    "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions",
  );
  assert.equal(ark.apiKey, "ark-key");
  // 该 lane 实测只接受 0.6，其他温度直接 400。
  assert.equal(ark.temperature, 0.6);
  // response_format 支持未用真 key 验证，先关，靠 prompt + parseJsonLoose。
  assert.equal(ark.jsonMode, false);
});

test("target 工厂：纯空白 key 归一为 undefined，绝不发出 Bearer 空头", () => {
  assert.equal(deepseekTarget("   ").apiKey, undefined);
  assert.equal(deepseekTarget("").apiKey, undefined);
  assert.equal(arkAgentPlanTarget("  ").apiKey, undefined);
  // 正常 key 去周边空白但保留本体。
  assert.equal(deepseekTarget("  real-key  ").apiKey, "real-key");
});

test("DEEPSEEK_BASE_URL only redirects the endpoint when explicitly set", () => {
  const previous = process.env.DEEPSEEK_BASE_URL;
  const previousNodeEnv = process.env.NODE_ENV;
  // deepseekUrl() ignores the override under NODE_ENV=production, so leaving the
  // ambient value in place makes `NODE_ENV=production npm run test:unit` a false
  // red against correct behaviour.
  Reflect.set(process.env, "NODE_ENV", "test");
  try {
    delete process.env.DEEPSEEK_BASE_URL;
    assert.equal(deepseekTarget("k").url, "https://api.deepseek.com/v1/chat/completions");
    process.env.DEEPSEEK_BASE_URL = "http://127.0.0.1:4321/v1/";
    assert.equal(deepseekTarget("k").url, "http://127.0.0.1:4321/v1/chat/completions");
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_BASE_URL;
    else process.env.DEEPSEEK_BASE_URL = previous;
    if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Reflect.set(process.env, "NODE_ENV", previousNodeEnv);
  }
});

test("production ignores the QA base-URL override", () => {
  const previousBase = process.env.DEEPSEEK_BASE_URL;
  const previousNodeEnv = process.env.NODE_ENV;
  // Next types NODE_ENV as read-only; Reflect keeps this test runtime-only.
  try {
    process.env.DEEPSEEK_BASE_URL = "https://evil.example/v1";
    Reflect.set(process.env, "NODE_ENV", "production");
    assert.equal(
      deepseekTarget("k").url,
      "https://api.deepseek.com/v1/chat/completions",
      "a stray env var must not redirect production user content",
    );
  } finally {
    if (previousBase === undefined) delete process.env.DEEPSEEK_BASE_URL;
    else process.env.DEEPSEEK_BASE_URL = previousBase;
    if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Reflect.set(process.env, "NODE_ENV", previousNodeEnv);
  }
});

test("buildChatBody：Ark target 强制温度 0.6 且不带 response_format", () => {
  const ark = arkAgentPlanTarget("ark-key");
  const body = buildChatBody(
    ark,
    [{ role: "user", content: "p" }],
    { maxTokens: 100, temperature: 0.9, json: true },
  ) as Record<string, unknown>;
  assert.equal(body.temperature, 0.6, "调用方的 0.9 必须被 target 级 0.6 覆盖");
  assert.equal("response_format" in body, false, "Ark 初始不支持 json_object 模式");
  assert.equal(body.max_tokens, 100);
});

test("buildChatBody：DeepSeek target 保留调用方温度并带 json_object", () => {
  const ds = deepseekTarget("ds-key");
  const body = buildChatBody(
    ds,
    [{ role: "user", content: "p" }],
    { maxTokens: 100, temperature: 0.4, json: true },
  ) as Record<string, unknown>;
  assert.equal(body.temperature, 0.4);
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("chatTargetChain：按 DeepSeek → Ark 顺序并过滤无 key 的 target", () => {
  const prev = {
    ds: process.env.DEEPSEEK_API_KEY,
    ark: process.env.ARK_API_KEY,
  };
  process.env.DEEPSEEK_API_KEY = "ds";
  process.env.ARK_API_KEY = "ark";
  try {
    const chain = chatTargetChain().map((t) => t.id);
    assert.deepEqual(chain, ["deepseek", "ark"]);
    // fallback 链不含主力自身。
    assert.deepEqual(
      chatFallbackTargets().map((t) => t.id),
      ["ark"],
    );
  } finally {
    restoreEnv(prev);
  }
});

test("chatTargetChain：两家 key 全缺时返回空链（调用方据此 fail-closed）", () => {
  const prev = {
    ds: process.env.DEEPSEEK_API_KEY,
    ark: process.env.ARK_API_KEY,
  };
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.ARK_API_KEY;
  try {
    assert.equal(chatTargetChain().length, 0);
    assert.equal(chatFallbackTargets().length, 0);
    // 显式传 key 仍可构造（测试与特殊调用点不受 env 缺失影响）。
    assert.equal(arkAgentPlanTarget("explicit").apiKey, "explicit");
    assert.equal(deepseekTarget("explicit").apiKey, "explicit");
  } finally {
    restoreEnv(prev);
  }
});

test("targetLabel：id 到日志显示名的映射只有这一份", () => {
  assert.equal(targetLabel("deepseek"), "DeepSeek");
  assert.equal(targetLabel("ark"), "Ark");
  // 未知 id 原样返回，不凭空造名字。
  assert.equal(targetLabel("lilith"), "lilith");
});

function restoreEnv(prev: { ds?: string; ark?: string }) {
  if (prev.ds === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = prev.ds;
  if (prev.ark === undefined) delete process.env.ARK_API_KEY;
  else process.env.ARK_API_KEY = prev.ark;
}
