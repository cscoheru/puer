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
  FIELD_CONFIDENCE_THRESHOLD,
  NOTE_CONFIDENCE_THRESHOLD,
  groundDescriptors,
  groundGrams,
  groundVessel,
  normalizeDelta,
  normalizeForMatch,
  normalizeStage,
  type Delta,
  type Stage,
} from "./vocab.ts";
import { buildExtractionPrompt, PROMPT_VERSION } from "./prompt.ts";

const MINIMAX_URL = "https://api.minimax.cn/v1/chat/completions";
const MINIMAX_MODEL = "MiniMax-M3";
const MINIMAX_TIMEOUT_MS = 45_000;

const LILITH_URL =
  process.env.LILITH_LLM_URL || "http://lilith:11434/v1/chat/completions";
const LILITH_MODEL = process.env.LILITH_LLM_MODEL || "qwen2.5:7b";
const LILITH_TIMEOUT_MS = 60_000;

export interface ExtractedFields {
  stage: Stage | null;
  deltaVsPrev: Delta | null;
  descriptors: string[];
  grams: number | null;
  vessel: string | null;
}

export interface ExtractionMeta {
  model: string;
  source: "minimax" | "lilith";
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
  source: "minimax" | "lilith";
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

  const delta = normalizeDelta(raw.deltaVsPrev);
  if (raw.deltaVsPrev != null && delta === null) {
    dropped.deltaVsPrev = "模型输出无法映射到已知比较结果";
  }

  const confidence = {
    stage: clamp01(conf.stage),
    deltaVsPrev: clamp01(conf.deltaVsPrev),
    grams: clamp01(conf.grams),
    vessel: clamp01(conf.vessel),
    descriptors: clamp01(conf.descriptors),
  };

  // ── 接地校验：原文没写的，一律不写 ──────────────────────────────
  const rawGrams = raw.grams;
  let grams = groundGrams(rawGrams, originalText);
  if (rawGrams != null && grams === null) {
    dropped.grams = "原文未出现该投茶量";
  }

  const rawVessel = raw.vessel;
  let vessel = groundVessel(rawVessel, originalText);
  if (rawVessel != null && vessel === null) {
    dropped.vessel = "原文未出现该器具";
  } else if (
    rawVessel != null &&
    vessel !== null &&
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

  // 置信度闸会把字段置空；先把「模型原本想写的」留一份给复核队列。
  const attempted: ExtractedFields = {
    stage,
    deltaVsPrev: delta,
    descriptors: [...descriptors],
    grams,
    vessel,
  };

  // ── 置信度闸：字段级不达标就不落库 ─────────────────────────────
  if (stage && confidence.stage < FIELD_CONFIDENCE_THRESHOLD) {
    dropped.stage = `置信度 ${confidence.stage.toFixed(2)} 低于阈值`;
    // 注意：stage 不置 null，留给复核队列参考；调用方按 dropped 决定是否写。
  }
  if (delta && confidence.deltaVsPrev < FIELD_CONFIDENCE_THRESHOLD) {
    dropped.deltaVsPrev = `置信度 ${confidence.deltaVsPrev.toFixed(2)} 低于阈值`;
  }
  if (grams && confidence.grams < FIELD_CONFIDENCE_THRESHOLD) {
    grams = null;
    dropped.grams = `置信度 ${confidence.grams.toFixed(2)} 低于阈值`;
  }
  if (vessel && confidence.vessel < FIELD_CONFIDENCE_THRESHOLD) {
    vessel = null;
    dropped.vessel = `置信度 ${confidence.vessel.toFixed(2)} 低于阈值`;
  }
  if (descriptors.length && confidence.descriptors < FIELD_CONFIDENCE_THRESHOLD) {
    descriptors = [];
    dropped.descriptors = `置信度 ${confidence.descriptors.toFixed(2)} 低于阈值`;
  }

  const values = [confidence.stage, confidence.deltaVsPrev, confidence.grams, confidence.vessel, confidence.descriptors];
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const correctedKeys = Object.keys(corrected);
  const needsReview =
    avg < NOTE_CONFIDENCE_THRESHOLD ||
    Object.keys(dropped).length > 0 ||
    correctedKeys.length > 0;

  const meta: ExtractionMeta = {
    model: reply.model,
    source: reply.source,
    promptVersion: PROMPT_VERSION,
    extractedAt: new Date().toISOString(),
    confidence,
    dropped,
    corrected,
    needsReview,
    reviewReason: needsReview
      ? Object.keys(dropped).length || correctedKeys.length
        ? [...Object.keys(dropped), ...correctedKeys.map((k) => `${k}(已纠正)`)].join("; ")
        : `平均置信度 ${avg.toFixed(2)} 低于阈值`
      : undefined,
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
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error("MINIMAX_API_KEY 未设置");

  try {
    const raw = await callMiniMax(prompt, apiKey);
    return { raw, model: MINIMAX_MODEL, source: "minimax" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    const isQuota = /429|402|2056|quota|exceed|insufficient/i.test(msg);
    if (!isQuota) throw e;
    const raw = await callLilith(prompt);
    return { raw, model: LILITH_MODEL, source: "lilith" };
  }
}

async function callMiniMax(prompt: string, apiKey: string): Promise<unknown> {
  const res = await fetch(MINIMAX_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MINIMAX_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_completion_tokens: 600,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
    }),
    signal: AbortSignal.timeout(MINIMAX_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return parseContent(data);
}

async function callLilith(prompt: string): Promise<unknown> {
  const res = await fetch(LILITH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: LILITH_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 600,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(LILITH_TIMEOUT_MS),
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
