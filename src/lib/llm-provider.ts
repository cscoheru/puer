/**
 * LLM 调用的唯一参考实现（AGENTS.md R27 规则 3）。
 *
 * ## 为什么要有这一层
 *
 * 仓库里过去每个调用点各写一份 `fetch(...)`，参数组合（`max_completion_tokens`
 * vs `max_tokens`、`thinking:disabled`、`response_format`）靠人肉记忆保持一致，
 * 结果就是「src/ 切了、scripts/ 没切」的半切换事故（R25）。
 *
 * 现在 MiniMax 的调用只有这一处，各管线只声明「我要这个 prompt、这个 token 上限」。
 *
 * ## 兜底顺序
 *
 *   MiniMax →（可选）GLM →（可选）lilith tailnet
 *
 * MiniMax 是主力也是兜底：**配额类错误先原地重试**（配额会恢复，重试比换模型划算，
 * 也避免同一个数据集里混进不同模型的判断），重试仍失败才按需降级。
 * 非配额类错误（鉴权、格式）立刻抛出 —— 换家挨个试一遍只会把真问题埋掉。
 */

const MINIMAX_URL = "https://api.minimax.cn/v1/chat/completions";
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || "MiniMax-M3";
const MINIMAX_TIMEOUT_MS = 45_000;

const GLM_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const GLM_MODEL = process.env.GLM_MODEL || "glm-4-flash";

/** 配额/限流类错误：值得重试或换家。 */
const QUOTA_RE = /429|402|2056|quota|exceed|insufficient|rate.?limit/i;

/**
 * 内容层面的错误（模型返回的不是合法 JSON）：同样值得重试 ——
 * 下一次大概率就规规矩矩返回 JSON 了。这类错误不是鉴权问题，不该立即放弃。
 */
export class LLMOutputError extends Error {}

/**
 * 从模型输出里尽最大努力抠出 JSON 对象。
 *
 * 实测 MiniMax-M3 偶尔在 JSON 前后夹带解释文字，或用全角引号，导致
 * 直接 JSON.parse 失败（2026-10-23 的 F1 回填有 28/1668 条栽在这上面）。
 * 三级兜底：直接解析 → 取第一个平衡的花括号块 → 去掉尾逗号再解析。
 */
export function parseJsonLoose(text: string): unknown {
  const raw = text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    // 继续兜底
  }

  const block = extractBalancedObject(raw);
  if (block) {
    try {
      return JSON.parse(block);
    } catch {
      // 继续兜底
    }
    const repaired = block.replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(repaired);
    } catch {
      // 放弃
    }
  }

  throw new LLMOutputError(`无法从输出中解析 JSON：${raw.slice(0, 160)}`);
}

/** 找出第一个平衡的 {...}（跳过字符串字面量里的括号）。 */
function extractBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
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
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export interface LLMTarget {
  id: string;
  url: string;
  model: string;
  /** MiniMax 用 max_completion_tokens，Ollama/GLM 用 max_tokens。 */
  maxKey: "max_tokens" | "max_completion_tokens";
  apiKey?: string;
  /** 无 Authorization 头的本地服务（lilith / Ollama）。 */
  noAuth?: boolean;
  extra?: Record<string, unknown>;
}

export interface CallOptions {
  /** 输出上限。默认 600，够一次结构化抽取。 */
  maxTokens?: number;
  timeoutMs?: number;
  /** 配额类错误的重试次数（不含首次）。默认 2。 */
  retries?: number;
  /** 重试间隔（毫秒），按次数递增。默认 [2000, 8000]。 */
  backoffMs?: number[];
  /** MiniMax 之外可用的降级目标，按顺序尝试。 */
  fallbacks?: LLMTarget[];
  /** 强制 JSON 输出。默认 true。 */
  json?: boolean;
  temperature?: number;
}

export interface LLMRawResult {
  /** 解析后的 JSON（json=true 时）或原始文本。 */
  content: unknown;
  /** 实际服务的供应商 id。 */
  source: string;
  model: string;
}

export function minimaxTarget(apiKey = process.env.MINIMAX_API_KEY): LLMTarget {
  return {
    id: "minimax",
    url: MINIMAX_URL,
    model: MINIMAX_MODEL,
    maxKey: "max_completion_tokens",
    apiKey,
    extra: { thinking: { type: "disabled" } },
  };
}

export function glmTarget(apiKey = process.env.GLM_API_KEY): LLMTarget {
  return {
    id: "glm",
    url: GLM_URL,
    model: GLM_MODEL,
    maxKey: "max_tokens",
    apiKey,
  };
}

export function ollamaTarget(
  id: string,
  url: string,
  model: string,
): LLMTarget {
  return { id, url, model, maxKey: "max_tokens", noAuth: true };
}

function isQuotaError(msg: string): boolean {
  return QUOTA_RE.test(msg);
}

/** 单次调用；失败抛 Error，消息里带状态码与响应片段。 */
async function callOnce(
  target: LLMTarget,
  prompt: string,
  opts: CallOptions,
): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!target.noAuth && target.apiKey) {
    headers.Authorization = `Bearer ${target.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: target.model,
    messages: [{ role: "user", content: prompt }],
    temperature: opts.temperature ?? 0,
    [target.maxKey]: opts.maxTokens ?? 600,
    ...(opts.json === false ? {} : { response_format: { type: "json_object" } }),
    ...(target.extra ?? {}),
  };

  const res = await fetch(target.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? MINIMAX_TIMEOUT_MS),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`LLM ${target.id} ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`LLM ${target.id} 返回空内容`);
  if (opts.json === false) return content;
  try {
    return parseJsonLoose(String(content));
  } catch (e) {
    throw new LLMOutputError(`LLM ${target.id} ${(e as Error).message}`);
  }
}

/**
 * 调用 LLM。MiniMax 主力 + 重试 + 可选降级。
 *
 * @param target    主力目标（一般是 MiniMax）
 * @param prompt    提示词
 * @param opts      token 上限、重试、降级目标等
 */
export async function callLLM(
  target: LLMTarget,
  prompt: string,
  opts: CallOptions = {},
): Promise<LLMRawResult> {
  const retries = opts.retries ?? 2;
  const backoff = opts.backoffMs ?? [2000, 8000];
  const chain: LLMTarget[] = [target, ...(opts.fallbacks ?? [])];
  const failures: string[] = [];

  for (let i = 0; i < chain.length; i++) {
    const t = chain[i];
    if (!t.noAuth && !t.apiKey) {
      failures.push(`${t.id}:未配置 key`);
      continue;
    }
    for (let attempt = 0; attempt <= (i === 0 ? retries : 0); attempt++) {
      try {
        const content = await callOnce(t, prompt, opts);
        return { content, source: t.id, model: t.model };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const quota = isQuotaError(msg);
        // 网络/超时也算可重试；鉴权/格式错误立即失败
        // 配额错误、输出格式错误、网络抖动都值得重试；
        // 鉴权错误(401/403)与参数错误立即失败，别拿错 key 挨家试。
        const retriable =
          quota ||
          e instanceof LLMOutputError ||
          /fetch failed|timeout|ETIMEDOUT|ECONNRESET/i.test(msg);
        if (!retriable) throw e;
        if (attempt < (i === 0 ? retries : 0)) {
          const wait = backoff[Math.min(attempt, backoff.length - 1)];
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        failures.push(`${t.id}:${msg.slice(0, 80)}`);
        break;
      }
    }
  }

  throw new Error(`所有 LLM 供应商都不可用 → ${failures.join(" | ")}`);
}
