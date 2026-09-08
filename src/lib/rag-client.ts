import { z } from "zod";

/**
 * Client for the internal rag-service container (Python FastAPI on puer-net).
 * The service is not exposed publicly; only this app talks to it, with the
 * shared RAG_SERVICE_TOKEN. Answers can take 10-60s+ (OCR + retrieval + LLM),
 * hence the long timeout.
 */
const RAG_URL = process.env.RAG_SERVICE_URL ?? "http://rag-service:8000";
const RAG_TOKEN = process.env.RAG_SERVICE_TOKEN ?? "";

const AskResult = z.object({
  question: z.string(),
  answer: z.string(),
  sources: z.array(z.object({ source: z.string(), kind: z.string() })).default([]),
  citations: z.array(z.string()).default([]),
  confidence: z.string(),
  queries: z.array(z.string()).default([]),
  ocr: z.array(z.unknown()).default([]),
  n_hits: z.number(),
  embed_used: z.boolean(),
  // W3-1: structured refusal state. When set, the RAG pipeline intentionally
  // skipped the LLM and returned a deterministic fallback message instead.
  // The UI should render it as a dedicated refusal card (out_of_scope /
  // no_image / low_confidence / multiple_matches / non_tea_product /
  // unreadable_image / conflicting_signals).
  refusal: z.string().nullish(),
  refusal_msg: z.string().nullish(),
  // W3-2: true when the RAG sqlite content-cache served this response without
  // rerunning the pipeline (identical images + normalized question, 24h TTL).
  cached: z.boolean().nullish(),
  // visual comparison stage (donghe reference images); absent when the
  // pipeline ran text-only or the visual assets were unavailable
  visual: z
    .object({
      ok: z.boolean(),
      brand: z.string().default(""),
      best: z
        .object({
          skuId: z.string(),
          name: z.string(),
          verdict: z.string(),
          confidence: z.number(),
          notes: z.string().default(""),
          // W3-0 + W3-1: tea_type lifted from visual_match.record to the
          // top-level best so it survives the record strip and reaches
          // the frontend. Enables the UI to flag 熟/生 conflicts against
          // OCR text (refusal state 7: conflicting_signals) and helps the
          // user self-correct before submitting.
          tea_type: z.string().nullish(),
        })
        .nullish(),
    })
    .default({ ok: false, brand: "", best: null }),
});

export type AskResult = z.infer<typeof AskResult>;

export async function askRag(
  input: {
    question: string;
    image_urls?: string[];
    topk?: number;
    trace_id?: string;
  },
  opts?: {
    /**
     * W3-2: propagate the caller's abort (route handler passes req.signal).
     * Combined with the 300s ceiling via AbortSignal.any — the browser abort
     * now tears down the app→RAG connection, which the RAG watcher turns
     * into a mid-pipeline cancel instead of running M3 compares to completion
     * for a client that is already gone. Node ≥20.3.
     */
    signal?: AbortSignal;
  },
): Promise<AskResult> {
  const res = await fetch(`${RAG_URL}/api/ask`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(RAG_TOKEN ? { Authorization: `Bearer ${RAG_TOKEN}` } : {}),
    },
    body: JSON.stringify(input),
    signal: AbortSignal.any(
      opts?.signal
        ? [AbortSignal.timeout(300_000), opts.signal]
        : [AbortSignal.timeout(300_000)],
    ),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data as { detail?: string }).detail || `rag service ${res.status}`;
    throw new Error(detail);
  }
  return AskResult.parse(data);
}
