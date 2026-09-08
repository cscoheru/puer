"use client";

import { useRef, useState } from "react";
import { useSession } from "next-auth/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { uploadFile } from "@/lib/upload-client";
import { useLocale } from "@/i18n/context";

interface Source {
  source: string;
  kind: string;
}

interface AskResult {
  question: string;
  answer: string;
  sources: Source[];
  citations: string[];
  // W3-1: "refused" added for structured refusal states. The RAG pipeline
  // skips the LLM and returns a deterministic fallback message instead.
  confidence: "high" | "medium" | "low" | "refused";
  n_hits: number;
  embed_used: boolean;
  ocr?: unknown[];
  visual?: { ok: boolean; brand?: string; best?: { name: string; verdict: string; confidence: number; tea_type?: string } | null };
  review?: { autoSubmitted: boolean; reviewId?: string };
  // W3-1: structured refusal (out_of_scope / no_image / low_confidence /
  // multiple_matches / non_tea_product / unreadable_image / conflicting_signals)
  refusal?: string;
  refusal_msg?: string;
}

const SUGGESTED = [
  "7542 各年份行情如何？",
  "紫大益怎么识别？",
  "什么是红印圆茶？",
  "干仓和湿仓怎么区分？",
];

const KIND_LABEL: Record<string, string> = {
  sku: "SKU 记录",
  donghe: "东和行情",
  knowledge: "知识库",
};

function ConfidenceBadge({ level }: { level: string }) {
  const cls =
    level === "high"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : level === "medium"
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-stone-100 text-stone-500 border-stone-200";
  const label = level === "high" ? "高置信" : level === "medium" ? "中置信" : "低置信";
  return <span className={`text-xs px-2 py-0.5 rounded-full border ${cls}`}>{label}</span>;
}

export default function AskPage() {
  const { data: session } = useSession();
  const { _ } = useLocale();
  const [question, setQuestion] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [reviewSent, setReviewSent] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const timedOutRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || images.length >= 3) return;
    setUploading(true);
    setError("");
    try {
      // raw: skip client-side compression — OCR needs the wrapper fine print
      // at full resolution (5MB server cap is plenty for a phone photo).
      const { url } = await uploadFile(file, undefined, undefined, "", { raw: true });
      setImages((v) => [...v, url]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "图片上传失败");
    } finally {
      setUploading(false);
    }
  };

  const submit = async (q?: string) => {
    const text = (q ?? question).trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    setReviewSent(false);
    setElapsed(0);
    timedOutRef.current = false;
    abortRef.current = new AbortController();
    // W1-4: abort on our own clock at 2min, so the user sees a clear timeout
    // message instead of the browser's opaque "Failed to fetch" (which nginx
    // logs as 499). The server keeps running to maxDuration=300 — the answer
    // still lands in TRACE logs for diagnosis even if the user gave up.
    const timeout = setTimeout(() => {
      timedOutRef.current = true;
      abortRef.current?.abort();
    }, 120_000);
    const tick = setInterval(() => setElapsed((v) => v + 1), 1000);
    try {
      const res = await fetch("/api/qa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, image_urls: images }),
        signal: abortRef.current.signal,
      });
      // nginx/Next may answer with an HTML error page (504 timeout etc.) —
      // check the payload before JSON.parse or the user sees "Unexpected token '<'"
      const raw = await res.text();
      let data: { error?: string } = {};
      try {
        data = JSON.parse(raw);
      } catch {
        /* HTML error page */
      }
      if (!res.ok) {
        throw new Error(
          data.error ||
            (res.status === 502 || res.status === 504
              ? "回答超时或服务繁忙，请稍后重试"
              : `提问失败 (${res.status})`)
        );
      }
      setResult(data as AskResult);
    } catch (err) {
      // order matters: our own timeout also surfaces as AbortError
      if (timedOutRef.current) {
        setError("识别超时（已等待超过2分钟）。服务可能繁忙，请稍后重试，或改用文字提问。");
      } else if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "提问失败");
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(tick);
      setBusy(false);
      abortRef.current = null;
    }
  };

  const cancel = () => abortRef.current?.abort();

  // 手动提交人工鉴定 — 对 AI 结论存疑时把本次问答(图+问题+AI初判)送人工队列
  const submitReview = async () => {
    if (!result || busy || reviewSent) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: result.question,
          image_urls: images,
          ai_answer: result.answer,
          ai_verdict: result.visual?.best?.verdict,
          ai_confidence: result.visual?.best?.confidence,
          ai_sku_name: result.visual?.best?.name,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "提交失败");
      }
      setReviewSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交人工鉴定失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-stone-800">🍵 {_("茶问")}</h1>
        <p className="text-sm text-stone-500 mt-1">
          {_("普洱茶行情、断代、品鉴知识问答，回答基于 6000+ SKU 行情与知识库检索并附来源引用。")}
        </p>
      </div>

      {/* input card */}
      <div className="bg-white rounded-2xl border border-amber-100 shadow-sm p-4 space-y-3">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          placeholder={_("问点什么，例如：03四星孔雀现在什么行情？")}
          rows={3}
          maxLength={500}
          disabled={busy}
          className="w-full resize-none rounded-xl border border-stone-200 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-amber-200 focus:border-amber-300 disabled:bg-stone-50"
        />

        {/* image thumbs + upload */}
        <div className="flex items-center gap-2 flex-wrap">
          {images.map((u) => (
            <div key={u} className="relative group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt="" className="w-14 h-14 object-cover rounded-lg border border-stone-200" />
              <button
                onClick={() => setImages((v) => v.filter((x) => x !== u))}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-stone-700 text-white text-xs leading-none opacity-0 group-hover:opacity-100 transition"
                aria-label={_("移除图片")}
              >
                ×
              </button>
            </div>
          ))}
          {images.length < 3 && (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || busy || !session?.user}
              title={session?.user ? _("上传茶图（棉纸/汤色/内飞）") : _("登录后可上传图片")}
              className="w-14 h-14 rounded-lg border border-dashed border-stone-300 text-stone-400 hover:border-amber-400 hover:text-amber-500 transition disabled:opacity-50 flex items-center justify-center text-xl"
            >
              {uploading ? "…" : "+"}
            </button>
          )}
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onPickImage} />
          {!session?.user && (
            <span className="text-xs text-stone-400">{_("登录后可上传图片（文本问答无需登录）")}</span>
          )}
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-stone-400">{question.length}/500 · ⌘/Ctrl+Enter {_("发送")}</span>
          {busy ? (
            <button onClick={cancel} className="px-4 py-2 text-sm rounded-full bg-stone-200 text-stone-600 hover:bg-stone-300 transition">
              {_("取消")}
            </button>
          ) : (
            <button
              onClick={() => submit()}
              disabled={!question.trim()}
              className="px-5 py-2 text-sm rounded-full bg-amber-600 text-white hover:bg-amber-700 disabled:bg-stone-200 disabled:text-stone-400 transition"
            >
              {_("提问")}
            </button>
          )}
        </div>
      </div>

      {/* suggested questions */}
      {!result && !busy && (
        <div className="mt-4 flex flex-wrap gap-2">
          {SUGGESTED.map((s) => (
            <button
              key={s}
              onClick={() => submit(s)}
              className="text-xs px-3 py-1.5 rounded-full border border-stone-200 text-stone-600 hover:border-amber-300 hover:text-amber-700 hover:bg-amber-50 transition"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {busy && (
        <div className="mt-6 text-center text-sm text-stone-500 py-8">
          <div className="inline-block w-6 h-6 border-2 border-amber-300 border-t-amber-600 rounded-full animate-spin mb-3" />
          <p>{images.length > 0 ? _("茶品识别中…") : _("正在检索行情与知识库…")}</p>
          <p className="text-xs text-stone-400 mt-1">
            {images.length > 0 ? _("通常 30–60 秒") : _("通常需要 10-60 秒")} · {_("已等待")} {elapsed}s
          </p>
        </div>
      )}

      {error && (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm p-4">{error}</div>
      )}

      {result && (
        <div className="mt-6 space-y-4">
          {/* W3-1: refusal state — render a dedicated banner before the
              answer card so the user sees a structured reason (low_confidence
              / multiple_matches / non_tea_product / etc.) instead of mixing
              the deterministic fallback into the LLM answer card. */}
          {result.refusal && (
            <div
              data-refusal={result.refusal}
              className="rounded-xl border border-amber-300 bg-amber-50 text-amber-900 text-sm p-4 flex items-start gap-2"
            >
              <span className="shrink-0 mt-px">⚠️</span>
              <div className="flex-1">
                <div className="font-medium mb-1">
                  {_("无法直接识别")} · <span className="font-mono text-xs">{result.refusal}</span>
                </div>
                <div>{result.refusal_msg || result.answer}</div>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <ConfidenceBadge level={result.confidence} />
            <span className="text-xs text-stone-400">
              {result.n_hits} {_("条检索证据")}
              {result.ocr?.length
                ? (result.ocr as { obscured?: string[] }[]).every((o) =>
                    o?.obscured?.includes("extraction_failed")
                  )
                  ? ` · ${_("图片识别不可用，仅按文字作答")}`
                  : ` · ${result.ocr.length} ${_("张图已识别")}`
                : ""}
            </span>
          </div>

          <div className="bg-white rounded-2xl border border-amber-100 shadow-sm p-5 prose prose-sm prose-stone max-w-none prose-headings:text-stone-800 prose-p:my-2 prose-li:my-0.5 prose-table:my-3 prose-th:px-2 prose-td:px-2">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
              {result.answer}
            </ReactMarkdown>
          </div>

          {/* 人工鉴定兜底:低置信自动送审提示 / 手动送审入口 */}
          {(result.review?.autoSubmitted || reviewSent) && (
            <div className="rounded-xl border border-sky-200 bg-sky-50 text-sky-800 text-sm p-4 flex items-start gap-2">
              <span className="shrink-0 mt-px">👮</span>
              <div>
                {_("已提交人工鉴定，请耐心等待。")}
                <a href="/ask/reviews" className="underline underline-offset-2 ml-1">
                  {_("查看我的鉴定")}
                </a>
              </div>
            </div>
          )}
          {!result.review?.autoSubmitted && !reviewSent && images.length > 0 && session?.user && (
            <div className="flex items-center gap-3">
              <button
                onClick={submitReview}
                disabled={busy}
                className="px-4 py-2 text-sm rounded-full border border-stone-300 text-stone-600 hover:border-sky-400 hover:text-sky-700 hover:bg-sky-50 transition disabled:opacity-50"
              >
                {_("对结论存疑？提交人工鉴定")}
              </button>
              <a href="/ask/reviews" className="text-xs text-stone-400 underline underline-offset-2">
                {_("我的鉴定")}
              </a>
            </div>
          )}

          {result.sources.length > 0 && (
            <div className="rounded-xl border border-stone-100 bg-stone-50/60 p-4">
              <p className="text-xs font-medium text-stone-500 mb-2">{_("来源")}</p>
              <ul className="space-y-1">
                {result.sources.map((s, i) => (
                  <li key={i} className="text-xs text-stone-600 flex items-start gap-1.5">
                    <span className="shrink-0 mt-px px-1.5 py-0.5 rounded bg-white border border-stone-200 text-stone-500">
                      {KIND_LABEL[s.kind] || s.kind}
                    </span>
                    <span className="break-all">{s.source}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
