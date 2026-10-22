/**
 * F1 抽取执行器（PRD v0.3 §5 Phase 1）。
 *
 * 调用链与仓库既有 AI 调用保持一致（AGENTS.md R27 规则 3）：
 * MiniMax-M3（`max_completion_tokens` + `thinking:disabled`）→ 仅配额类错误
 * 才降级到 lilith tailnet 本地模型。参数组合照抄 `src/lib/moderation.ts`。
 *
 * 与审核链路的差别：这里**必须**让调用方区分「模型没写」与「模型写了但
 * 没通过接地校验」。因此返回值把 raw 与 grounded 分开，并带上原因，
 * 批处理脚本据此决定写库还是进复核队列。
 */

import {
  DEFAULT_GRAMS,
  DEFAULT_VESSEL,
  FIELD_CONFIDENCE_THRESHOLD,
  findGramValue,
  groundDescriptors,
  groundGrams,
  groundVessel,
  normalizeDelta,
  normalizeForMatch,
  normalizeStage,
  type Delta,
  type FieldBasis,
  type Stage,
} from "./vocab.ts";
import { buildExtractionPrompt, PROMPT_VERSION } from "./prompt.ts";

/**
 * 供应商链：按顺序尝试，配额类错误才降级到下一家。
 *
 * 2026-10-22 实测：MiniMax 的 Token Plan 用量打满（429/2056），
 * DeepSeek 与 GLM 正常。所以「一家挂了整条管线停摆」是不可接受的 ——
 * 回填 1600 条要跑很久，中途配额耗尽必须有后备。
 */
interface ProviderSpec {
  id: string;
  env: string;
  url: string;
  model: string;
  maxKey: "max_tokens" | "max_completion_tokens";
  extra?: Record<string, unknown>;
}

const PROVIDERS: ProviderSpec[] = [
  {
    id: "minimax",
    env: "MINIMAX_API_KEY",
    url: "https://api.minimax.cn/v1/chat/completions",
    model: process.env.MINIMAX_MODEL || "MiniMax-M3",
    maxKey: "max_completion_tokens",
    extra: { thinking: { type: "disabled" } },
  },
  {
    id: "deepseek",
    env: "DEEPSEEK_API_KEY",
    url: "https://api.deepseek.com/v1/chat/completions",
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    maxKey: "max_tokens",
  },
  {
    id: "glm",
    env: "GLM_API_KEY",
    url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: process.env.GLM_MODEL || "glm-4-flash",
    maxKey: "max_tokens",
  },
];

const LLM_TIMEOUT_MS = 45_000;

export interface ExtractedFields {
  stage: Stage | null;
  deltaVsPrev: Delta | null;
  descriptors: string[];
  grams: number | null;
  vessel: string | null;
}

export interface ExtractionMeta {
  model: string;
  /** 实际使用的供应商 id（minimax / deepseek / glm）。 */
  source: string;
  promptVersion: string;
  extractedAt: string;
  confidence: {
    stage: number;
    deltaVsPrev: number;
    grams: number;
    vessel: number;
    descriptors: number;
  };
  /** 被接地校验丢弃的字段及原因，审计用。 */
  dropped: Record<string, string>;
  /** 被接地校验纠正的字段（模型值 → 原文值），审计用。 */
  corrected: Record<string, string>;
  /** 每个字段的出处：原文直述 / 推断 / 缺省值。 */
  basis: {
    stage: FieldBasis | null;
    deltaVsPrev: FieldBasis | null;
    grams: FieldBasis | null;
    vessel: FieldBasis | null;
    descriptors: FieldBasis | null;
  };
  /** 整条是否需要人工复核。 */
  needsReview: boolean;
  reviewReason?: string;
  /**
   * 复核队列要展示的「模型原本想写的值」。字段被丢弃/纠正时，这里保留原值，
   * 否则复核者只能看到一个空字段，无从判断是模型没写还是被闸掉了。
   */
  suggested?: ExtractedFields;
}

export interface ExtractionResult {
  ok: boolean;
  fields: ExtractedFields;
  meta: ExtractionMeta | null;
  reason?: string;
}

export interface ExtractArgs {
  title?: string | null;
  content: string;
  previousStage?: string | null;
  /** 冒烟测试用：注入调用器，避免单测真的打网络。 */
  callLLM?: (prompt: string) => Promise<LLMReply>;
}

export interface LLMReply {
  raw: unknown;
  model: string;
  /** 实际使用的供应商 id（minimax / deepseek / glm）。 */
  source: string;
}

const emptyFields = (): ExtractedFields => ({
  stage: null,
  deltaVsPrev: null,
  descriptors: [],
  grams: null,
  vessel: null,
});

function clamp01(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * 抽取一条笔记。**不抛异常** —— 批处理里单条失败不应中断整批。
 */
export async function extractTastingFields(
  args: ExtractArgs,
): Promise<ExtractionResult> {
  const prompt = buildExtractionPrompt({
    title: args.title,
    content: args.content,
    previousStage: args.previousStage,
  });

  let reply: LLMReply;
  try {
    reply = args.callLLM
      ? await args.callLLM(prompt)
      : await callWithFallback(prompt);
  } catch (e) {
    return {
      ok: false,
      fields: emptyFields(),
      meta: null,
      reason: e instanceof Error ? e.message : String(e),
    };
  }

  return validateReply(reply, args.content);
}

/**
 * 把模型输出规整 + 接地校验，得出可写库的字段。
 * 拆成独立纯函数，便于用固定 JSON 做单测（不打网络）。
 */
export function validateReply(
  reply: LLMReply,
  originalText: string,
): ExtractionResult {
  const raw = (reply.raw ?? {}) as Record<string, unknown>;
  const conf = (raw.confidence ?? {}) as Record<string, unknown>;
  const dropped: Record<string, string> = {};
  const corrected: Record<string, string> = {};

  const stage = normalizeStage(raw.stage);
  if (raw.stage != null && stage === null) {
    dropped.stage = "模型输出无法映射到已知阶段";
  }
  // 出处：模型声明 stated 才当原文直述，其余（含未声明）按推断处理。
  const stageBasis: FieldBasis | null = stage
    ? raw.stageBasis === "stated"
      ? "stated"
      : "inferred"
    : null;

  let delta = normalizeDelta(raw.deltaVsPrev);
  if (raw.deltaVsPrev != null && delta === null) {
    dropped.deltaVsPrev = "模型输出无法映射到已知比较结果";
  }
  // delta 不做推断：没有「上次」作参照，推出来的方向没有依据。
  let deltaBasis: FieldBasis | null = delta ? "stated" : null;

  const confidence = {
    stage: clamp01(conf.stage),
    deltaVsPrev: clamp01(conf.deltaVsPrev),
    grams: clamp01(conf.grams),
    vessel: clamp01(conf.vessel),
    descriptors: clamp01(conf.descriptors),
  };

  // ── 投茶量：原文写了就用原文，没写才补默认值 ────────────────────
  const rawGrams = raw.grams;
  let grams = groundGrams(rawGrams, originalText);
  let gramsBasis: FieldBasis | null = grams != null ? "stated" : null;
  if (grams == null && rawGrams != null) {
    dropped.grams = "原文未出现该投茶量";
  }
  if (grams == null && rawGrams != null) {
    // 只在「模型认为原文有投茶量、但数字对不上」时才回原文找。
    // 模型说没有就尊重它的语义判断 —— 否则正则会把「茶样共 23 克」这种
    // 总量误当成投茶量，这正是语义判断存在的意义。
    const fromText = findGramValue(originalText);
    if (fromText != null) {
      grams = fromText;
      gramsBasis = "stated";
      corrected.grams = `补自原文 → ${fromText}`;
      // 模型给错了、但原文里找得到正确值 —— 这是纠正，不是冲突。
      delete dropped.grams;
    }
  }
  if (grams == null) {
    grams = DEFAULT_GRAMS;
    gramsBasis = "default";
    // 原文没写投茶量不是「冲突」，不该进复核队列 —— 只是补了个默认值。
    delete dropped.grams;
    if (rawGrams != null) corrected.grams = `${String(rawGrams)} → 默认 ${DEFAULT_GRAMS}`;
  }

  // ── 器具：原文写了就用原文，没写才补默认值 ──────────────────────
  const rawVessel = raw.vessel;
  let vessel = groundVessel(rawVessel, originalText);
  let vesselBasis: FieldBasis | null = vessel ? "stated" : null;
  if (vessel == null) {
    vessel = DEFAULT_VESSEL;
    vesselBasis = "default";
    if (rawVessel != null) corrected.vessel = `${String(rawVessel)} → 默认 ${DEFAULT_VESSEL}`;
  } else if (
    rawVessel != null &&
    normalizeForMatch(String(rawVessel)) !== normalizeForMatch(vessel)
  ) {
    corrected.vessel = `${String(rawVessel)} → ${vessel}`;
  }

  const rawDesc = raw.descriptors;
  let descriptors = groundDescriptors(rawDesc, originalText);
  const rawDescCount = Array.isArray(rawDesc)
    ? rawDesc.length
    : typeof rawDesc === "string"
      ? rawDesc.split(/[,，、;；\s]+/).filter(Boolean).length
      : 0;
  if (rawDescCount > descriptors.length) {
    dropped.descriptors = `原文未出现的描述词已丢弃 ${rawDescCount - descriptors.length} 个`;
  }

  // 复核队列要看到「模型原本想写的」，而不是被闸掉之后的空值。
  const attempted: ExtractedFields = {
    stage,
    deltaVsPrev: delta,
    descriptors: [...descriptors],
    grams: groundGrams(rawGrams, originalText),
    vessel: groundVessel(rawVessel, originalText),
  };

  // ── 置信度闸：只对「有参照物的事实判断」设闸 ───────────────────
  // stage 是推断，低置信也保留（basis=inferred 已说明性质）；
  // grams / vessel / descriptors 已接地，无需置信度再拦一道；
  // 只有 delta 说「比上次好/差」，模型没把握时宁可不写。
  if (delta && confidence.deltaVsPrev < FIELD_CONFIDENCE_THRESHOLD) {
    dropped.deltaVsPrev = `置信度 ${confidence.deltaVsPrev.toFixed(2)} 低于阈值`;
    delta = null;
    deltaBasis = null;
  }

  const basis = {
    stage: stageBasis,
    deltaVsPrev: deltaBasis,
    grams: gramsBasis,
    vessel: vesselBasis,
    descriptors: descriptors.length ? ("stated" as FieldBasis) : null,
  };

  // 默认值与纠正不算「需要人看」——站长明确说了不想逐条过。
  // 只有模型与原文冲突（dropped）时才进复核。
  const needsReview = Object.keys(dropped).length > 0;

  const meta: ExtractionMeta = {
    model: reply.model,
    source: reply.source,
    promptVersion: PROMPT_VERSION,
    extractedAt: new Date().toISOString(),
    confidence,
    basis,
    dropped,
    corrected,
    needsReview,
    reviewReason: needsReview ? Object.keys(dropped).join("; ") : undefined,
    suggested: needsReview ? attempted : undefined,
  };

  return {
    ok: true,
    fields: { stage, deltaVsPrev: delta, descriptors, grams, vessel },
    meta,
  };
}

// ─── LLM 调用（与 moderation.ts 同构）──────────────────────────────────────

async function callWithFallback(prompt: string): Promise<LLMReply> {
  const failures: string[] = [];

  for (const p of PROVIDERS) {
    const apiKey = process.env[p.env];
    if (!apiKey) {
      failures.push(`${p.id}:未配置 ${p.env}`);
      continue;
    }
    try {
      const raw = await callProvider(prompt, p, apiKey);
      return { raw, model: p.model, source: p.id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 只有「配额/限流」类错误才换下一家；鉴权错误、格式错误都应当立刻暴露，
      // 否则会拿着错 key 挨个供应商试一遍，把真正的问题埋掉。
      const retriable = /429|402|2056|quota|exceed|insufficient|rate.?limit/i.test(msg);
      if (!retriable) throw e;
      failures.push(`${p.id}:${msg.slice(0, 60)}`);
    }
  }

  throw new Error(`所有 LLM 供应商都不可用 → ${failures.join(" | ")}`);
}

async function callProvider(
  prompt: string,
  p: ProviderSpec,
  apiKey: string,
): Promise<unknown> {
  const res = await fetch(p.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: p.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      [p.maxKey]: 600,
      response_format: { type: "json_object" },
      ...(p.extra ?? {}),
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return parseContent(data);
}

function parseContent(data: unknown): unknown {
  const d = data as { choices?: { message?: { content?: string } }[] };
  const content = d?.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM 返回空内容");
  return JSON.parse(content);
}
