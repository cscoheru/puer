import { test } from "node:test";
import assert from "node:assert/strict";
import { callLLM, type LLMTarget } from "./llm-provider.ts";

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
