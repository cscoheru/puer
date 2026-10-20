/**
 * 资讯稿的 AI 改写（面向 PentAGI 每周检索到的行业/市场/品鉴素材）。
 *
 * ## 为什么不复用 `src/lib/tea-drafts/adapt.ts` 的 `deepSeekAdapt`
 *
 * 那条链路的 system prompt 硬绑定品鉴笔记：
 * 「把作者本人的品鉴记录改编成一篇论坛帖子——只保留作者亲口写的品鉴事实，
 * 把产品资料、市场行情、历史考据全部剔除」。
 * 资讯稿要做的恰恰相反：主体就是市场行情与产品资料。所以 prompt 必须另写。
 *
 * 但它那套**安全层是纯函数且与业务无关**，直接复用：
 *  - `isGrounded` / `extractNumberTokens` —— 数字接地校验；
 *  - `checkAdaptLength` —— 长度闸（资讯稿的比例区间不同，见 `NEWS_RATIO_*`）；
 *  - `sanitizeNoteHtml` + `stripToContentTags` —— HTML 白名单；
 *  - `extractPlainText` / `codepointLength` —— 纯文本与码点计数。
 *
 * ## 失败契约
 *
 * 与 `deepSeekAdapt` 一致：**返回 `{ok:false, reason}`，绝不抛异常**。调用方
 * （`scripts/ai-news-draft.mjs`）逐条处理，单条失败不影响整批。
 */

import { sanitizeNoteHtml, stripToContentTags } from "../tea-drafts/sanitize.ts";
import { escapeHtml, SUMMARY_MAX_LENGTH } from "../tea-drafts/assemble.ts";
import { extractPlainText, codepointLength } from "../tea-drafts/source-html.ts";
import type { Material } from "./plan.ts";

/**
 * 资讯稿专用的数字 tokenization：**小数点算一个 token 的一部分**。
 *
 * `adapt.ts` 的 `extractNumberTokens` 用 `/[0-9]+/g`，把 `10.6` 拆成 `10` 和
 * `6`。对品鉴笔记够用（年份、克重、评分都是整数），但对**行情稿是漏洞**：
 * 素材写「10.6 万元」，模型写成「10 万元」——整数 token `10` 在素材里存在
 * （它是 `10.6` 的前缀）→ 接地校验放行。而「价格被抹掉小数位」恰恰是资讯稿
 * 最不该出的错。
 *
 * 所以资讯侧自己实现：`/[0-9]+(?:\.[0-9]+)?/g`，让 `10.6` 是一个整体 token。
 * 这样「10」不在素材 token 集合里 → 拦下。实测：
 *   素材 `10.6 万元` + 改写 `18.5 万元` → 拦（18 不在集合）
 *   素材 `10.6 万元` + 改写 `10 万元`  → 拦（10 不在集合，小数敏感才成立）
 */
const NUMBER_TOKEN_RE = /[0-9]+(?:\.[0-9]+)?/g;

/** 提取文本里的数字串（小数点敏感）。 */
function newsNumberTokens(text: string): string[] {
  return text.match(NUMBER_TOKEN_RE) ?? [];
}

/**
 * 资讯稿的数字接地校验。
 *
 * 与 `isGrounded` 同语义（同理：输出里的每个数字串都必须在素材里出现过），
 * 但用资讯自己的 tokenization。
 */
function isNewsGrounded(
  adaptedText: string,
  corpus: string,
): { ok: true } | { ok: false; reason: string } {
  const need = new Set(newsNumberTokens(adaptedText));
  if (need.size === 0) return { ok: true };
  const have = new Set(newsNumberTokens(corpus));
  for (const token of need) {
    if (!have.has(token)) {
      return { ok: false, reason: `ungrounded number: ${token}` };
    }
  }
  return { ok: true };
}

/**
 * MiniMax 端点与模型。
 *
 * 参数模式（R25/R27 沉淀的参考实现，与 `src/lib/moderation.ts`、`adapt.ts` 同款）：
 * `api.minimax.cn` + `MiniMax-M3` + `max_completion_tokens`（**不是** `max_tokens`）
 * + `thinking:{type:"disabled"}`（默认 adaptive 太慢）+ `response_format:{type:"json_object"}`
 * + `AbortSignal.timeout`。
 */
const MINIMAX_URL = "https://api.minimax.cn/v1/chat/completions";
const MINIMAX_MODEL = "MiniMax-M3";

const REWRITE_TIMEOUT_MS = 45_000;
const REWRITE_TEMPERATURE = 0.4;
const REWRITE_MAX_TOKENS = 2000;
const REWRITE_ATTEMPTS = 2;

/** 资讯稿的绝对长度区间（码点）。 */
const NEWS_MIN_CODEPOINTS = 80;
const NEWS_MAX_CODEPOINTS = 2000;

/**
 * 资讯稿的长度比例区间（改写长度 / 素材长度）。
 *
 * 与品鉴笔记的 0.2–2.0 不同：品鉴笔记是「一份记录 → 一篇同篇幅的复述」，
 * 比例天然接近 1；资讯素材常常是上万字的报价表或综述，改写成一篇帖子是
 * **大幅压缩**，0.2 的下限会把「浓缩得当」误杀成「太短」。这里放宽到
 * 0.05–1.5：下界保证不产出空洞的骨架，上界防止模型把原文整段照抄。
 */
const NEWS_RATIO_MIN = 0.05;
const NEWS_RATIO_MAX = 1.5;

/** 素材类型 → 中文标签，用于在 prompt 里告诉模型这条素材是什么。 */
const KIND_LABEL: Record<Material["kind"], string> = {
  market: "行业/市场动态（价格、行情、渠道、投资）",
  tasting: "品鉴记录（口感、香气、汤色、批次品质）",
  knowledge: "茶知识（工艺、仓储、标准、术语）",
};

/**
 * 改写结果。
 *
 * 与 `AdaptResult` 同形，便于调用方统一处理。
 */
export type NewsRewriteResult =
  | { ok: true; content: string; summary: string; title: string }
  | { ok: false; reason: string };

export interface NewsRewriteOptions {
  material: Material;
  /** 可注入以便测试；默认用全局 fetch。 */
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /** 覆盖标题；缺省时用素材原标题（会裁剪到 `MAX_TITLE_LENGTH`）。 */
  title?: string;
}

/**
 * 资讯稿的 system prompt。
 *
 * 与品鉴版的关键差别有三处：
 *  1. 角色是「茶市观察者」而不是「茶友」——转述行情需要克制，不是抒情；
 *  2. **要求标出来源**（平台 / 标题 / 发布日期），这是资讯帖的可信度锚点；
 *  3. 明确「不写冲泡步骤、不写口感」——那是品鉴稿的地盘，混进来会跑版。
 */
const NEWS_SYSTEM =
  "你是普洱茶社区里一位常年跟踪茶市的观察者。任务：把检索到的资讯素材改写成一篇面向茶友的论坛帖子——忠实转述素材里的事实与数字,按指定文风组织,绝不编造素材中没有的年份、价格、批次、产地或他人评价。";

/** 构造改写 prompt。素材全文必须原样附上（不能只给模型摘要）。 */
function buildPrompt(m: Material): string {
  const source = [
    m.platform ? `来源平台:${m.platform}` : "",
    `原标题:${m.title || "(无)"}`,
    m.publishedAt ? `发布日期:${m.publishedAt}` : "",
    m.url ? `原文链接:${m.url}` : "",
    `素材类型:${KIND_LABEL[m.kind]}`,
    "",
    "【素材正文】",
    m.body,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    "请把下方「素材正文」改写成一篇普洱茶论坛的资讯帖。",
    "",
    "【硬性约束】",
    "- 只能使用素材里已经出现的事实。不得编造年份、价格、批次数、产地、评分、机构名或他人评价。",
    "- 【数字必须与原文一致】年份、价格、批次数、克重、提数、百分比等一律照抄，不得换算、不得四舍五入、不得推断。素材里没有的数字不许出现。",
    "- 【素材里出现的关键数字必须保留】行情稿的价值就在数字——价格、涨跌幅、批次、克重、日期，只要素材正文里有，改写时就要写进对应的要点里，不能只说「大幅调低」「明显回调」这种没有数字的空话。宁可少写一个要点，也不要写没有数字支撑的行情判断。",
    "- 【不得编造来源】素材里没写来源平台/作者/日期时，不要替它补上；此时就当匿名行业消息写，不要写「据XX报道」这种你没依据的出处。",
    "- 素材里没有明确日期时，不要自己判断年份，直接不写日期。",
    "- 不要写冲泡步骤、水温投茶量、耐泡度、逐泡口感——那是品鉴帖的内容，不属于资讯帖。",
    "- 结构要求的元素若素材里没有，直接省略，不要为凑结构而编造。",
    "- 第一人称、口语化,像一个真人在论坛通报情况。",
    "- 只能使用这些 HTML 标签:<p> <b> <i> <h2> <ul> <li>。不要使用 <img>、<a>、<script> 或任何属性。",
    "",
    "【文风】市况速览",
    "写成一条茶市观察：像在跟茶友通报行情，语气克制、有判断但不煽动，不用营销腔。",
    "【结构】先给这周行情的一句话结论，再用 2-3 个要点分条说明（价格/批次/产区/渠道各一），每个要点都要落到具体数字或具体茶品上；结尾一句说给谁参考。不写冲泡、不写口感。",
    "",
    source,
    "",
    "【输出格式】",
    "严格返回 JSON 对象(不要 markdown 代码块):",
    '{"title":"帖子标题","content":"正文 HTML","summary":"一句话概括的摘要(纯文本,40字以内)"}',
    "标题 12-30 字,概括这条资讯讲了什么,不要用「震惊」「速看」这类营销词。",
    "摘要要包含素材里最关键的那个数字或事实。",
  ].join("\n");
}

/** 最佳努力地从模型输出里抠出 JSON（容忍代码围栏与前后废话）。 */
function parseLooseJson(raw: string): { title?: unknown; content?: unknown; summary?: unknown } | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { title?: unknown; content?: unknown; summary?: unknown };
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as { title?: unknown; content?: unknown; summary?: unknown };
    } catch {
      return null;
    }
  }
}

/**
 * 裁剪摘要到 DB 列宽上限（按码点，不切代理对）。
 *
 * 顺手剥掉 markdown 表格残留的管道符：素材常来自行情报价表（`| 37 | 503 | … |`），
 * 模型偶尔会把表格里的 `|` 带进摘要尾部，读起来像「结论。|」这种脏尾巴。
 */
function clipSummary(summary: string): string {
  const cleaned = summary.replace(/[|\s]+$/g, "").trim();
  const escaped = escapeHtml(cleaned).trim();
  if (codepointLength(escaped) <= SUMMARY_MAX_LENGTH) return escaped;
  return Array.from(escaped).slice(0, SUMMARY_MAX_LENGTH).join("");
}

/** 裁剪标题到 `Article.title` 的列宽上限（`@db.VarChar(200)`）。 */
function clipTitle(title: string): string {
  const escaped = escapeHtml(title).trim();
  if (codepointLength(escaped) <= 200) return escaped;
  return Array.from(escaped).slice(0, 200).join("");
}

/** 单次模型调用。失败返回原因，不抛。 */
async function runAttempt(
  opts: NewsRewriteOptions,
  key: string,
): Promise<NewsRewriteResult> {
  const { material } = opts;
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? REWRITE_TIMEOUT_MS;

  let resp: Response;
  try {
    resp = await fetcher(MINIMAX_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        messages: [
          { role: "system", content: NEWS_SYSTEM },
          { role: "user", content: buildPrompt(material) },
        ],
        temperature: REWRITE_TEMPERATURE,
        max_completion_tokens: REWRITE_MAX_TOKENS,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, reason: `fetch error: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    return { ok: false, reason: `MiniMax ${resp.status}: ${errText.slice(0, 200)}` };
  }

  let body: { choices?: { message?: { content?: string }; finish_reason?: string }[] };
  try {
    body = (await resp.json()) as typeof body;
  } catch {
    return { ok: false, reason: "MiniMax returned non-JSON body" };
  }

  const choice = body?.choices?.[0];
  const raw = choice?.message?.content ?? "";
  const finish = choice?.finish_reason;
  const parsed = parseLooseJson(raw);
  if (!parsed) {
    const detail =
      finish === "length"
        ? "truncated at max_completion_tokens"
        : !raw
          ? "empty model content"
          : "unparseable model JSON";
    return { ok: false, reason: `no JSON object in model response (${detail}, finish=${finish ?? "?"})` };
  }

  const contentHtml = typeof parsed.content === "string" ? parsed.content : "";
  const summaryRaw = typeof parsed.summary === "string" ? parsed.summary : "";
  const titleRaw = typeof parsed.title === "string" ? parsed.title : "";
  if (!contentHtml.trim() || !summaryRaw.trim()) {
    return { ok: false, reason: "empty content or summary" };
  }

  // 过同一道 HTML 白名单：模型不能留下链接、属性或脚本。
  const sanitized = stripToContentTags(sanitizeNoteHtml(contentHtml));
  if (!sanitized.trim()) return { ok: false, reason: "empty after sanitize" };

  const plain = extractPlainText(sanitized);
  const sourceLen = codepointLength(material.body);
  const adaptedLen = codepointLength(plain);
  if (adaptedLen < NEWS_MIN_CODEPOINTS) {
    return { ok: false, reason: `adapted too short: ${adaptedLen}cp` };
  }
  if (adaptedLen > NEWS_MAX_CODEPOINTS) {
    return { ok: false, reason: `adapted too long: ${adaptedLen}cp` };
  }
  if (sourceLen > 0) {
    const ratio = adaptedLen / sourceLen;
    if (ratio < NEWS_RATIO_MIN) {
      return { ok: false, reason: `adapted ${ratio.toFixed(2)}x < ${NEWS_RATIO_MIN}x of source` };
    }
    if (ratio > NEWS_RATIO_MAX) {
      return { ok: false, reason: `adapted ${ratio.toFixed(2)}x > ${NEWS_RATIO_MAX}x of source` };
    }
  }

  // 数字接地：正文 + 摘要 + 标题里出现的每一个数字串，都必须能在素材里找到。
  //
  // 语料**只含素材正文与标题**，刻意不含 `publishedAt`：日期会被拆成
  // `2026-10-07` → `2026` / `10` / `07`，那个 `10` 会让语料里凭空多出一个
  // 数字 token，于是「素材写 10.6 万、模型写 10 万」被放行（`10` 既来自日期
  // 又是 `10.6` 的前缀）。日期是元信息不是价格事实，不该进数字空间。
  //
  // 但正文/标题/摘要里**可以合法出现发布日期**（引用出处时写日期是正常的），
  // 所以先把输出里与素材发布日期完全一致的日期串剔除，再做接地校验。
  const adaptedText = `${plain} ${summaryRaw} ${titleRaw}`;
  const withoutDates = material.publishedAt
    ? adaptedText.split(material.publishedAt).join(" ")
    : adaptedText;
  const grounded = isNewsGrounded(withoutDates, `${material.body} ${material.title}`);
  if (!grounded.ok) return { ok: false, reason: grounded.reason };

  return {
    ok: true,
    content: sanitized,
    summary: clipSummary(summaryRaw),
    title: clipTitle(titleRaw || material.title),
  };
}

/**
 * 把一条素材改写成资讯帖。
 *
 * 与 `deepSeekAdapt` 同契约：返回结果，不抛异常；内部重试 `REWRITE_ATTEMPTS` 次。
 */
export async function rewriteNews(
  opts: NewsRewriteOptions,
): Promise<NewsRewriteResult> {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) return { ok: false, reason: "MINIMAX_API_KEY missing" };

  let last: NewsRewriteResult = { ok: false, reason: "no attempt ran" };
  for (let attempt = 1; attempt <= REWRITE_ATTEMPTS; attempt++) {
    last = await runAttempt(opts, key);
    if (last.ok) return last;
    // 配额/限流类错误不可重试：重试只会更快烧额度、拖长整批时间。
    // 立即返回（reason 里保留 429，调用方据此熔断整批）。
    if (!last.ok && /\b429\b|rate_limit|用量上限|额度|积分/.test(last.reason)) {
      return last;
    }
  }
  return {
    ok: false,
    reason: `${last.reason} (after ${REWRITE_ATTEMPTS} attempts)`,
  };
}

/**
 * 素材里出现的全部数字串（供调用方在日志里展示「这条稿引用了哪些数字」）。
 *
 * 排障时有用：数字接地失败时，能立刻看出模型编的是哪个数。
 * 用资讯自己的小数点敏感 tokenization——`10.6` 作为一个整体报出，
 * 而不是 `10` 和 `6`。
 */
export function materialNumbers(m: Material): string[] {
  return [...new Set(newsNumberTokens(`${m.title} ${m.body}`))];
}
