import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { checkRateLimit, rateLimitKey, getClientIP, LIMIT_QA } from "@/lib/rate-limit";
import { screenContent } from "@/lib/moderation";
import { askRag } from "@/lib/rag-client";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// pipeline = OCR (up to 3 images) + retrieval + visual compare (DINO/CLIP CPU
// + up to 4 M3 pairwise comparisons) + LLM generation; keep in sync with
// rag-client's AbortSignal timeout (300s).
export const maxDuration = 300;

const schema = z.object({
  question: z.string().trim().min(1).max(500),
  image_urls: z.array(z.string().max(200)).max(3).optional(),
  topk: z.number().int().min(3).max(12).optional(),
});

// Only same-site upload paths reach the rag service (defense before upstream,
// which re-validates against its own base URL).
const IMG_RE = /^\/uploads\/forum\/[A-Za-z0-9._-]+\.(jpe?g|png|gif|webp)$/;

export async function POST(req: NextRequest) {
  // 登录可选:游客可文本问答(限流更紧),登录后可带图(上传接口本身要求登录)
  const session = await auth();
  const ip = getClientIP(req);
  const { allowed } = checkRateLimit(
    rateLimitKey(ip, session?.user?.id ? `qa:${session.user.id}` : "qa:anon"),
    LIMIT_QA
  );
  if (!allowed) {
    return NextResponse.json({ error: "提问过于频繁，请稍后再试" }, { status: 429 });
  }

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "参数不完整" }, { status: 400 });
  }

  // 文本审核:命中高危→拒绝;「review」放行——行情类问题会误触投资分类器,
  // 且问答内容不入库、无发布动作,不存在送审队列。
  const mod = await screenContent(body.question);
  if (mod.decision === "reject") {
    return NextResponse.json({ error: "问题含违规内容，无法回答" }, { status: 400 });
  }

  if ((body.image_urls ?? []).some((u) => !IMG_RE.test(u))) {
    return NextResponse.json({ error: "无效的图片地址" }, { status: 400 });
  }

  // W1-1: correlate this request across app logs and the RAG TRACE line.
  // Declared before try so the abort log in catch can quote it.
  const traceId = crypto.randomUUID();
  const t0 = Date.now();
  try {
    const result = await askRag(
      {
        question: body.question,
        image_urls: body.image_urls ?? [],
        topk: body.topk ?? 6,
        trace_id: traceId,
      },
      // W3-2: browser abort → req.signal → app→RAG fetch abort → the RAG
      // disconnect watcher cancels the pipeline mid-flight. Before this, a
      // navigated-away client left the full OCR + M3 compare chain running.
      { signal: req.signal },
    );
    console.log(
      `[qa] trace=${traceId} ms=${Date.now() - t0} imgs=${(body.image_urls ?? []).length}` +
      ` verdict=${result.visual?.best?.verdict ?? "-"} conf=${result.visual?.best?.confidence ?? "-"}` +
      (result.refusal ? ` refusal=${result.refusal}` : ""),
    );

    // 低置信自动送人工鉴定(登录用户+带图):置信不足阈值、判定不确定、
    // 或用户在问真假而视觉判定非同款 — 宁可让用户等人工,不给假信心。
    // 匿名游客不建单(无 userId,前端也不展示人工入口)。
    // W3-1: refusal 状态已是有意拒答(LLM 未调), 不再触发 auto-review。
    let review: { autoSubmitted: boolean; reviewId?: string } | undefined;
    const best = result.visual.best;
    if (session?.user?.id && (body.image_urls ?? []).length > 0 && !result.refusal) {
      const threshold = Number(process.env.REVIEW_AUTO_THRESHOLD ?? 0.8);
      const asksAuthenticity = /真|假|鉴别|鉴定|真假/.test(body.question);
      const visualOk = result.visual.ok && best;
      const lowConfidence =
        !visualOk ||
        best!.confidence < threshold ||
        best!.verdict === "uncertain" ||
        (asksAuthenticity && best!.verdict !== "same_product");
      if (lowConfidence) {
        const rec = await prisma.teaReview
          .create({
            data: {
              userId: session.user.id,
              question: body.question,
              imageUrls: body.image_urls ?? [],
              source: "auto",
              aiAnswer: result.answer,
              aiVerdict: best?.verdict,
              aiConfidence: best?.confidence,
              aiSkuName: best?.name,
            },
            select: { id: true },
          })
          .catch(() => null);
        review = { autoSubmitted: Boolean(rec), reviewId: rec?.id };
      }
    }
    return NextResponse.json(review ? { ...result, review } : result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    const name = e instanceof Error ? e.name : "";
    // W3-2: the client is gone (browser abort / navigation / 300s ceiling).
    // The RAG pipeline was already cancelled via the propagated signal — this
    // branch exists so the abort is visible in app logs and not misreported
    // as a 502 service failure.
    if (req.signal.aborted || name === "AbortError" || name === "TimeoutError") {
      console.log(
        `[qa] aborted trace=${traceId} ms=${Date.now() - t0}` +
        ` cause=${req.signal.aborted ? "client_disconnect" : name}`,
      );
      return NextResponse.json({ error: "请求已取消" }, { status: 499 });
    }
    const status = /429|timeout|超时/i.test(msg) ? 429 : 502;
    return NextResponse.json(
      { error: status === 429 ? "问答服务繁忙，请稍后再试" : "问答服务暂不可用" },
      { status }
    );
  }
}
