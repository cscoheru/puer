/**
 * scripts 侧 LLM 调用的唯一参考实现。
 *
 * 对应 `src/lib/llm-provider.ts` 的 `deepseekTarget()` + `buildChatBody()`：
 * **端点和参数组合必须逐字一致**，改动时两处一起改（AGENTS.md R27 规则 3）。
 *
 * 为什么不直接 import 那个 .ts：脚本在宿主机直跑（cron-task.sh），也要在
 * app 容器里经 tsx 跑，两边的加载方式不同；一个纯 .mjs 对两边都成立。
 *
 * ## 供应商（2026-11-06 起）
 *
 * 主力是 DeepSeek（MiniMax 账号已终止；火山 coding plan 额度打满不可用）。
 * DeepSeek 是标准 OpenAI 兼容接口：`max_tokens`（不是 max_completion_tokens），
 * 支持 `response_format: {type:"json_object"}`。
 *
 * 兜底：GLM（`glm-4-flash`）。DeepSeek 402 欠费/429 限流时管线靠它活着，
 * 没有兜底链路的话自动回复/草稿会整条停摆。
 */

export const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
export const DEEPSEEK_CHAT_URL = "https://api.deepseek.com/v1/chat/completions";

const GLM_API_KEY = process.env.GLM_API_KEY;
const GLM_MODEL = process.env.GLM_MODEL || "glm-4-flash";
const GLM_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

/** 是否至少配置了一家可用的供应商。 */
export function llmConfigured() {
  return Boolean(DEEPSEEK_API_KEY || GLM_API_KEY);
}

/**
 * 按优先级返回可用的目标。没配 key 的直接跳过 —— 让「哪家能用」由环境决定，
 * 而不是在调用点写死。
 */
function targets() {
  const list = [];
  if (DEEPSEEK_API_KEY) {
    list.push({
      id: "deepseek",
      url: DEEPSEEK_CHAT_URL,
      model: DEEPSEEK_MODEL,
      apiKey: DEEPSEEK_API_KEY,
    });
  }
  if (GLM_API_KEY) {
    list.push({ id: "glm", url: GLM_URL, model: GLM_MODEL, apiKey: GLM_API_KEY });
  }
  return list;
}

/**
 * 与 src/lib/llm-provider.ts::buildChatBody 同款，但 `response_format` **默认不开**。
 *
 * 原因：脚本里有一半 prompt 是**标签式**的（`rag-post` 的 TITLE:/CONTENT:、
 * `auto-boost-new` 的纯文本回复），而 DeepSeek / GLM 的 `json_object` 模式
 * 要求 prompt 里出现 "json" 字样，否则直接 400。所以由调用方显式传
 * `json: true` 才加这个字段 —— 让「我想不想要 JSON」跟着 prompt 走，而不是
 * 跟着供应商走。
 */
export function buildChatBody(target, messages, opts = {}) {
  const { maxTokens = 600, temperature = 0, json = false } = opts;
  return {
    model: target.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    ...(json ? { response_format: { type: "json_object" } } : {}),
  };
}

/**
 * 调一次模型，返回纯文本（不做 JSON 解析，调用方按自己的格式解析）。
 * 主力失败（429 / 5xx / 网络）自动落到下一家；全部失败抛错。
 */
export async function llmChat(promptOrMessages, opts = {}) {
  const {
    maxTokens = 600,
    temperature = 0,
    timeoutMs = 60_000,
    json = false,
  } = opts;
  const messages =
    typeof promptOrMessages === "string"
      ? [{ role: "user", content: promptOrMessages }]
      : promptOrMessages;

  const all = targets();
  if (all.length === 0) {
    throw new Error("没有可用的 LLM 供应商（DEEPSEEK_API_KEY / GLM_API_KEY 均未设置）");
  }

  const failures = [];
  for (const t of all) {
    try {
      const res = await fetch(t.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${t.apiKey}`,
        },
        body: JSON.stringify(
          buildChatBody(t, messages, { maxTokens, temperature, json }),
        ),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        failures.push(`${t.id} ${res.status}: ${text.slice(0, 140)}`);
        continue;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        failures.push(`${t.id}: 返回非 JSON 响应体`);
        continue;
      }
      const content = data?.choices?.[0]?.message?.content ?? "";
      if (!content.trim()) {
        failures.push(`${t.id}: 返回空内容`);
        continue;
      }
      return content;
    } catch (e) {
      failures.push(`${t.id}: ${e.message}`);
    }
  }

  throw new Error(`所有 LLM 供应商都不可用 → ${failures.join(" | ")}`);
}

/** 从模型输出里尽最大努力抠出 JSON 对象（与 llm-provider.ts::parseJsonLoose 同款）。 */
export function parseJsonLoose(text) {
  const raw = String(text).trim();
  try {
    return JSON.parse(raw);
  } catch {
    // 继续
  }
  const start = raw.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const block = raw.slice(start, i + 1);
          try {
            return JSON.parse(block);
          } catch {
            return JSON.parse(block.replace(/,\s*([}\]])/g, "$1"));
          }
        }
      }
    }
  }
  throw new Error(`无法从输出中解析 JSON：${raw.slice(0, 160)}`);
}
