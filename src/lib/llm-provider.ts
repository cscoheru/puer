/**
 * LLM 调用的唯一参考实现（AGENTS.md R27 规则 3）。
 *
 * ## 为什么要有这一层
 *
 * 仓库里过去每个调用点各写一份 `fetch(...)`，参数组合（`max_completion_tokens`
 * vs `max_tokens`、`thinking:disabled`、`response_format`）靠人肉记忆保持一致，
 * 结果就是「src/ 切了、scripts/ 没切」的半切换事故（R25）。
 *
 * 现在 LLM 的调用只有这一处，各管线只声明「我要这个 prompt、这个 token 上限」。
 *
 * ## 供应商（2026-11-12 起）
 *
 * 主力是 **DeepSeek**（MiniMax 账号已终止）。第二供应商是**火山方舟
 * Agent Plan**（`/api/plan/v3` OpenAI 兼容面，专属 ARK_API_KEY）：
 * DeepSeek 配额耗尽时按链降级到它。Agent Plan 是套餐订阅制，
 * 不按量计费，适合当配额缓冲。
 *
 * DeepSeek 是标准 OpenAI 兼容接口，所以整条链路保持 OpenAI 形状 ——
 * 只换 base URL / model / env 名，参数面最小。
 *
 * MiniMax 的专有参数组合已删掉（`max_completion_tokens`、
 * `thinking:{type:"disabled"}`）；DeepSeek 用 `max_tokens`，并支持
 * `response_format: {type:"json_object"}`。
 *
 * ## 兜底顺序
 *
 *   DeepSeek → Ark Agent Plan（可选）
 *
 * 只有两家（2026-11-12 按站长要求收敛，GLM 与 lilith 本地兜底已下线）：
 * 主力 **配额类错误先原地重试**（402 欠费/429 限流会恢复，重试比换模型
 * 划算，也避免同一个数据集里混进不同模型的判断），重试仍失败才降级到
 * Ark。非配额类错误（鉴权、格式）立刻抛出 —— 换家挨个试一遍只会把
 * 真问题埋掉。
 */

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const DEEPSEEK_TIMEOUT_MS = 45_000;

// ── 火山方舟 Agent Plan（2026-11-12 新增，DeepSeek 配额耗尽时的第二供应商）──
// Agent Plan 的 OpenAI 兼容数据面是 /api/plan/v3（普通按量计费才是 /api/v3），
// 依据本机 arkcli-plans 技能的套餐矩阵；chat 路径与标准 OpenAI 一致。
const ARK_DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";
const ARK_CHAT_URL =
  (process.env.ARK_BASE_URL || ARK_DEFAULT_BASE_URL).replace(/\/+$/, "") +
  "/chat/completions";
// 套餐内模型名是账号相关的 output_name（控制台「Agent Plan」页可查），
// doubao-seed-2-0-pro 是当前套餐文档示例中的默认路由模型，可用 ARK_MODEL 覆盖。
const ARK_MODEL = process.env.ARK_MODEL || "doubao-seed-2-0-pro";
// 实测该 lane 的模型会以 400 拒绝 0.6 以外的 temperature
//（"temperature only 0.6 is allowed for this model"）。target 级默认值
// 在 buildChatBody 里覆盖调用方传入值；真 key 验证放宽后可用 ARK_TEMPERATURE 改。
const ARK_TEMPERATURE = process.env.ARK_TEMPERATURE
  ? Number(process.env.ARK_TEMPERATURE)
  : 0.6;

/** 配额/欠费/限流类错误：值得重试或换家。 */
const QUOTA_RE =
  /429|402|2056|quota|exceed|insufficient|rate.?limit|AccountQuotaExceeded/i;
// `2056` / `AccountQuotaExceeded` 是 MiniMax / 火山方舟的历史错误码,留着无害:
// 换供应商时旧码不会误伤新供应商,但新供应商的码必须在这里补齐。

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
  /** 少数供应商用 max_completion_tokens；DeepSeek/Ark 都是 max_tokens。 */
  maxKey: "max_tokens" | "max_completion_tokens";
  apiKey?: string;
  extra?: Record<string, unknown>;
  /**
   * 是否支持 OpenAI 的 `response_format: {type:"json_object"}`。
   * DeepSeek 为 true；Ark Agent Plan 为 false。
   */
  jsonMode?: boolean;
  /**
   * target 级 temperature 覆盖，优先级高于调用方传入值。
   * 给 Ark Agent Plan 这种「只接受固定采样参数」的套餐 lane 用 —— 调用点
   * 继续按自己的场景传 0/0.4/0.9，发到 Ark 时在这里被统一改写。
   */
  temperature?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CallOptions {
  /** 输出上限。默认 600，够一次结构化抽取。 */
  maxTokens?: number;
  timeoutMs?: number;
  /** 配额类错误的重试次数（不含首次）。默认 2。 */
  retries?: number;
  /** 重试间隔（毫秒），按次数递增。默认 [2000, 8000]。 */
  backoffMs?: number[];
  /** 主力之外可用的降级目标，按顺序尝试。 */
  fallbacks?: LLMTarget[];
  /** 强制 JSON 输出。默认 true。 */
  json?: boolean;
  temperature?: number;
  /** 可选 system prompt；和 prompt 一起构成 messages。 */
  system?: string;
}

export interface LLMRawResult {
  /** 解析后的 JSON（json=true 时）或原始文本。 */
  content: unknown;
  /** 实际服务的供应商 id。 */
  source: string;
  model: string;
}

/**
 * DeepSeek（OpenAI 兼容）。
 *
 * `DEEPSEEK_API_KEY` 是生产 `.env` 里既有的那把；`DEEPSEEK_MODEL` 默认
 * `deepseek-chat`（也可显式设成 `deepseek-reasoner`，但结构化抽取用 chat 更稳）。
 */
export function deepseekTarget(apiKey = process.env.DEEPSEEK_API_KEY): LLMTarget {
  return {
    id: "deepseek",
    url: DEEPSEEK_URL,
    model: DEEPSEEK_MODEL,
    maxKey: "max_tokens",
    // env 读取边界归一：纯空白 key 当未配置，绝不发出 `Bearer  ` 这种头。
    apiKey: apiKey?.trim() || undefined,
    jsonMode: true,
  };
}

/**
 * 火山方舟 Agent Plan（OpenAI 兼容 `/api/plan/v3`，Bearer 专属 Key）。
 *
 * 没有 `ARK_API_KEY` 时返回的 target 不带 key，`callLLM` 会自动跳过，
 * 所以把它放进 fallback 数组是安全的。
 *
 * `jsonMode: false` 是刻意的：套餐 lane 是否接受 `response_format` 尚未用
 * 真 key 验证过，而所有 JSON 调用点的 prompt 都明文要求 JSON 且外面有
 * `parseJsonLoose()` 兜底；等 `llm-provider-probe` 验证支持后再打开。
 */
export function arkAgentPlanTarget(
  apiKey = process.env.ARK_API_KEY,
): LLMTarget {
  return {
    id: "ark",
    url: ARK_CHAT_URL,
    model: ARK_MODEL,
    maxKey: "max_tokens",
    // 与 deepseekTarget 同一道 env 归一：空白 key = 未配置。
    apiKey: apiKey?.trim() || undefined,
    jsonMode: false,
    temperature: Number.isFinite(ARK_TEMPERATURE) ? ARK_TEMPERATURE : 0.6,
  };
}

/**
 * 规范的降级链（已过滤掉没配 key 的 target）：
 * 完整链 DeepSeek → Ark Agent Plan；fallback 数组只用 Ark。
 * 各调用点不许再手抄一份顺序（R28 规则 1：白名单/常量只有一份实现）。
 */
export function chatTargetChain(): LLMTarget[] {
  return [deepseekTarget(), arkAgentPlanTarget()].filter((t) => t.apiKey);
}

export function chatFallbackTargets(): LLMTarget[] {
  return [arkAgentPlanTarget()].filter((t) => t.apiKey);
}

/**
 * target id → 面向日志/错误文案的显示名。
 *
 * 手工 fetch 链路（tea-drafts/adapt、news-draft/rewrite）的失败原因
 * 长期带 `DeepSeek <status>` 前缀且被单测钉住，新增供应商时不许各文件
 * 再手抄一份 id→名称映射（R28 规则 1）。
 */
export function targetLabel(id: string): string {
  switch (id) {
    case "deepseek":
      return "DeepSeek";
    case "ark":
      return "Ark";
    default:
      return id;
  }
}

/**
 * 构造 OpenAI 形状的请求体 —— 所有调用点（含 scripts 侧的 `scripts/lib/llm.mjs`）
 * 必须用同一份参数组合，避免 R25/R27 那种「这处改了、那处没改」的漂移。
 */
export function buildChatBody(
  target: LLMTarget,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; json?: boolean } = {},
): Record<string, unknown> {
  return {
    model: target.model,
    messages,
    // target 级覆盖（Ark 固定 0.6）优先于调用方按场景给的温度。
    temperature: target.temperature ?? opts.temperature ?? 0,
    [target.maxKey]: opts.maxTokens ?? 600,
    ...(opts.json === false || !target.jsonMode
      ? {}
      : { response_format: { type: "json_object" } }),
    ...(target.extra ?? {}),
  };
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
  if (target.apiKey) {
    headers.Authorization = `Bearer ${target.apiKey}`;
  }

  const messages: ChatMessage[] = [
    ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
    { role: "user", content: prompt },
  ];
  const body = buildChatBody(target, messages, {
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    json: opts.json,
  });

  const res = await fetch(target.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEEPSEEK_TIMEOUT_MS),
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
 * 调用 LLM。DeepSeek 主力 + 重试 + 可选降级。
 *
 * @param target    主力目标（一般是 deepseekTarget()）
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
    if (!t.apiKey) {
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
          // 5xx 是供应商侧故障（错误串形如 `LLM deepseek 503: ...`），值得重试/降级；
          // 4xx（鉴权、参数）仍旧立即失败，别拿错 key 挨家试。
          /\b5\d{2}\b/.test(msg) ||
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
