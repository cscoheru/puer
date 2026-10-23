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
  findGramValue,
  groundDelta,
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
import {
  callLLM,
  glmTarget,
  minimaxTarget,
  type LLMTarget,
} from "../llm-provider.ts";

/**
 * 供应商链：MiniMax 主力（配额错误原地重试）→ GLM。
 *
 * 2026-10-22 实测：MiniMax 的 Token Plan 会打满（429/2056），DeepSeek 直接
 * 402 欠费，GLM 正常。所以默认链是 MiniMax → GLM；DeepSeek 只有在明确指定
 * 时才用（它现在欠费，配额恢复了才有意义）。
 *
 * 重试由共享实现 `src/lib/llm-provider.ts` 负责，各管线不再各写一份 fetch。
 */
const PROVIDERS = ["minimax", "glm"] as const;

/**
 * DeepSeek：默认不参与，但保留定义以便配额恢复后显式启用。
 * 2026-10-22 实测 402 Insufficient Balance。
 */
const DEEPSEEK_TARGET = {
  id: "deepseek",
  url: "https://api.deepseek.com/v1/chat/completions",
  model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
  maxKey: "max_tokens" as const,
  apiKey: process.env.DEEPSEEK_API_KEY,
};

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
  /** 模型原话（规整前）。词表不认的阶段词会出现在这里，用来补词表。 */
  raw: { stage: string | null; deltaVsPrev: string | null };
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
  /** 只用这几家供应商（顺序即优先级）。用于「整批必须同一家模型」的场景。 */
  providers?: string[];
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
      : await callWithFallback(prompt, args.providers);
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

  // ── delta 以原文比较句为准（词面接地），不信模型自报的置信度 ──
  const grounded = groundDelta(originalText);
  if (grounded.delta) {
    if (delta && delta !== grounded.delta) {
      corrected.deltaVsPrev = `${delta} → ${grounded.delta}（原文「${grounded.evidence}」）`;
    }
    delta = grounded.delta;
    deltaBasis = "stated";
    delete dropped.deltaVsPrev;
  } else if (delta) {
    // 模型说有比较，原文里却找不到比较句式 —— 不认这个结论。
    dropped.deltaVsPrev = "原文没有与上次比较的表述";
    delta = null;
    deltaBasis = null;
  }

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

  // ── 置信度闸已退役 ────────────────────────────────────────────
  // stage 是推断，低置信也保留（basis=inferred 已说明性质）；
  // grams / vessel / descriptors 已接地；
  // delta 改由词面接地判定，不再看模型自报的把握。

  const basis = {
    stage: stageBasis,
    deltaVsPrev: deltaBasis,
    grams: gramsBasis,
    vessel: vesselBasis,
    descriptors: descriptors.length ? ("stated" as FieldBasis) : null,
  };

  // 复核只留给真正的分歧：模型说的阶段词我们词表不认（说明词表该补），
  // 或模型断言了原文里根本没有的比较。描述词少一两个、默认值、纠正都不算。
  const needsReview = Boolean(dropped.stage || dropped.deltaVsPrev);

  const meta: ExtractionMeta = {
    model: reply.model,
    source: reply.source,
    promptVersion: PROMPT_VERSION,
    extractedAt: new Date().toISOString(),
    confidence,
    basis,
    raw: {
      stage: typeof raw.stage === "string" ? raw.stage : null,
      deltaVsPrev: typeof raw.deltaVsPrev === "string" ? raw.deltaVsPrev : null,
    },
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

async function callWithFallback(
  prompt: string,
  only?: string[],
): Promise<LLMReply> {
  const chain = only?.length ? only : [...PROVIDERS];
  const fallbacks: LLMTarget[] = [];

  if (chain.includes("glm")) fallbacks.push(glmTarget());
  if (chain.includes("deepseek")) fallbacks.push(DEEPSEEK_TARGET);

  const res = await callLLM(minimaxTarget(), prompt, {
    maxTokens: 600,
    timeoutMs: LLM_TIMEOUT_MS,
    // 配额类错误原地重试：配额会恢复，换模型只会让同一个数据集混进两种判断。
    retries: 2,
    backoffMs: [2000, 8000],
    fallbacks,
  });

  return { raw: res.content, model: res.model, source: res.source };
}

function parseContent(data: unknown): unknown {
  const d = data as { choices?: { message?: { content?: string } }[] };
  const content = d?.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM 返回空内容");
  return JSON.parse(content);
}
