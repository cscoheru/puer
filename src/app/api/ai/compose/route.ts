import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  buildAiComposePrompt,
  canUseAiCompose,
  stripCodeFence,
} from "@/lib/ai-compose";
import { callLLM, deepseekTarget, glmTarget } from "@/lib/llm-provider";
import { sanitizeNoteHtml, stripToContentTags } from "@/lib/tea-drafts/sanitize";
import {
  checkRateLimit,
  getClientIP,
  rateLimitKey,
  LIMIT_AI_COMPOSE,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 一次完整生成（DeepSeek → GLM 兜底），与 llm-provider 的 45s 超时留出余量。
export const maxDuration = 60;

const schema = z.object({
  prompt: z.string().trim().min(1, "请写下创作要求").max(500),
  title: z.string().trim().max(200).optional(),
  boardName: z.string().trim().max(50).optional(),
  tea: z
    .object({
      name: z.string().trim().min(1).max(120),
      brand: z.string().trim().max(120).optional(),
      year: z.number().int().min(1900).max(2100).optional(),
    })
    .optional(),
});

/**
 * 发帖页「AI 创作」：把一段创作要求变成 HTML 正文初稿。
 *
 * 权限：只有站长（uid ∈ EDITOR_AUTHOR_UIDS）与 admin 能调 —— 前端隐藏按钮不算，
 * 直连接口也必须 403（R28b 第 4 条：页面与写接口两头都要判）。
 *
 * 输出只返回给浏览器，不落库；作者确认后照常走 `POST /api/boards/[slug]`，
 * 发布时的内容审核链路（screenContent）没有任何改动。
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || !canUseAiCompose(session.user)) {
    return NextResponse.json({ error: "无权使用 AI 创作" }, { status: 403 });
  }

  const { allowed } = checkRateLimit(
    rateLimitKey(getClientIP(req), `ai-compose:${session.user.id}`),
    LIMIT_AI_COMPOSE,
  );
  if (!allowed) {
    return NextResponse.json({ error: "创作次数过多，请稍后再试" }, { status: 429 });
  }

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    // 校验失败的不只是 prompt（title/tea 超长或年份越界也走这里），
    // 所以报错不能只说「创作要求」。
    return NextResponse.json(
      { error: "创作要求需 1–500 字，标题与茶品信息请检查后再试" },
      { status: 400 },
    );
  }

  const { system, user } = buildAiComposePrompt({
    prompt: body.prompt,
    title: body.title,
    boardName: body.boardName,
    tea: body.tea,
  });

  const t0 = Date.now();
  try {
    const result = await callLLM(deepseekTarget(), user, {
      system,
      // 必须显式 false：默认会带 response_format=json_object 并把返回当结构化数据解析
      json: false,
      maxTokens: 1200,
      temperature: 0.8,
      // 交互式生成，超时必须自己兜住：callLLM 默认 retries=2，配上 45s 单次超时
      // 最坏是 3×45s + 10s 退避，再加 GLM 兜底 45s ≈ 190s。而 /api/ai/compose
      // 落进 nginx 的 `location /`（默认 proxy_read_timeout 60s）→ 用户先拿到
      // 一个 HTML 的 504，模型那边还在烧 token。25s + 25s 兜底 = 最坏 50s。
      retries: 0,
      timeoutMs: 25_000,
      fallbacks: [glmTarget()],
    });

    // 模型产出属于不可信 HTML：先去掉偶发代码围栏，再按内容标签白名单收口。
    // 两道净化并联：sanitizeNoteHtml 先整段删掉 script/style/iframe 等，
    // stripToContentTags 再做白名单拆包 + 清属性（与 tea-drafts 的模型改写
    // 共用同一份实现，不另写一份规则）。
    const html = stripToContentTags(
      sanitizeNoteHtml(stripCodeFence(String(result.content ?? ""))),
    );
    if (!html.trim()) {
      console.error(`[ai-compose] empty output uid=${session.user.id} source=${result.source}`);
      return NextResponse.json({ error: "AI 没有返回内容，请重试" }, { status: 502 });
    }

    console.log(
      `[ai-compose] uid=${session.user.id} ms=${Date.now() - t0}` +
        ` source=${result.source} len=${html.length}`,
    );
    // 只回正文；供应商 id 留在服务端日志里，没必要告诉浏览器
    return NextResponse.json({ html });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ai-compose] failed uid=${session.user.id} ms=${Date.now() - t0} ${msg.slice(0, 200)}`);
    const busy = /429|402|quota|余额|timeout|超时|fetch failed/i.test(msg);
    return NextResponse.json(
      { error: busy ? "创作服务繁忙，请稍后再试" : "AI 创作暂不可用，请稍后再试" },
      { status: busy ? 429 : 502 },
    );
  }
}
