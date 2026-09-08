import { prisma } from "@/lib/prisma";

/**
 * 内容审核:本地敏感词 → AI(DeepSeek)→ 故障转人工 三层闸。
 * 决策三种:publish(直接发布) / review(进待审队列) / reject(直接拒绝提交)。
 * 策略(用户锁定):
 *  - 命中本地敏感词 → 直接 reject(本站只做真实茶品茶器交流,违规词在源头拦死,不浪费人工审核)
 *  - AI 放行 + 可疑送审(AI 判定违规或把握不足 → review)
 *  - AI 故障/超时 → fail-closed 送人工
 */

export type ModDecision = "publish" | "review" | "reject";

export interface ModResult {
  decision: ModDecision;
  categories: string[]; // political | adult | gambling | drug | investment | ...
  confidence: number; // 0-1
  reason: string;
  source: "keyword" | "ai" | "fallback";
}

const AI_TIMEOUT_MS = 8000;
const PUBLISH_CONFIDENCE = 0.7;
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

// ─── 本地敏感词缓存(60s)── 调用方在提交链路,需低延迟、低 DB 压力 ───────────────
let keywordCache: { rows: { keyword: string; category: string }[]; ts: number } = {
  rows: [],
  ts: 0,
};

async function getActiveKeywords() {
  const now = Date.now();
  if (keywordCache.rows.length && now - keywordCache.ts < 60_000) return keywordCache.rows;
  const rows = await prisma.sensitiveKeyword.findMany({
    where: { isActive: true },
    select: { keyword: true, category: true },
  });
  keywordCache = { rows, ts: now };
  return rows;
}

/**
 * 审核一段文本。title + content 等可拼成单个字符串传入。
 * 任何异常都不抛出 —— 提交链路依赖它返回一个确定性决策。
 */
export async function screenContent(text: string): Promise<ModResult> {
  // 去掉 HTML 标签后再匹配,防富文本编辑器把敏感词拆开(如 <strong>约</strong>炮)绕过
  const plain = (text || "").replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");
  const haystack = plain.toLowerCase();

  // 1) 本地敏感词层:命中即直接拒绝(本站只做真实茶品茶器交流,
  //    违规词在源头拦死,不让提交,也不浪费人工审核)
  try {
    const keywords = await getActiveKeywords();
    const hits = keywords.filter((k) => k.keyword && haystack.includes(k.keyword.toLowerCase()));
    if (hits.length) {
      return {
        decision: "reject",
        categories: [...new Set(hits.map((h) => h.category))],
        confidence: 1,
        reason: `内容含违规词,禁止发布: ${hits.map((h) => h.keyword).slice(0, 5).join(", ")}`,
        source: "keyword",
      };
    }
  } catch {
    // 关键词表读取失败不阻断 —— 继续交给 AI
  }

  // 2) AI 层:DeepSeek 分类。无 key 或任何错误 → fail-closed 送审
  if (!process.env.DEEPSEEK_API_KEY) {
    return {
      decision: "review",
      categories: [],
      confidence: 0,
      reason: "AI 未配置(DEEPSEEK_API_KEY 缺失),转人工",
      source: "fallback",
    };
  }

  try {
    const ai = await classifyByAI(text || "");
    if (ai.category && ai.category !== "normal") {
      return {
        decision: "review",
        categories: [ai.category],
        confidence: ai.confidence,
        reason: ai.reason || `AI 判定可疑(${ai.category})`,
        source: "ai",
      };
    }
    if (ai.confidence < PUBLISH_CONFIDENCE) {
      return {
        decision: "review",
        categories: [],
        confidence: ai.confidence,
        reason: "AI 把握不足,转人工",
        source: "ai",
      };
    }
    return {
      decision: "publish",
      categories: [],
      confidence: ai.confidence,
      reason: "AI 判定正常",
      source: "ai",
    };
  } catch {
    return {
      decision: "review",
      categories: [],
      confidence: 0,
      reason: "AI 调用失败/超时,转人工",
      source: "fallback",
    };
  }
}

// ─── DeepSeek 调用(模式取自 scripts/auto-post.mjs;timeout 取自 lib/sitemap-ping.ts)──
async function classifyByAI(
  text: string
): Promise<{ category: string; confidence: number; reason: string }> {
  const prompt = `你是中文社区内容安全审核员。对下面的用户提交内容做分类,用于一个普洱茶论坛的发帖审核。

只关注这几种违规:涉黄(adult)、赌博(gambling)、毒品(drug)、政治敏感(political)、违法违规投资引流(investment)。正常茶文化讨论、品鉴、交易、生活分享都算 normal。

注意:茶文化里"茶气""烟韵""仓储""杀青""内飞"等都是正常术语;不要把正常茶话误判。仅当内容确实包含上述违规信息(含引流联系方式/二维码暗示/隐晦色情赌博等)才标对应类别。

内容:
"""
${text.slice(0, 4000)}
"""

只返回 JSON,不要任何解释:{"category":"normal|adult|gambling|drug|political|investment","confidence":0到1的小数,"reason":"不超过30字的中文理由"}`;

  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`DeepSeek ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(content);
  const confidence = Number(parsed.confidence);
  return {
    category: typeof parsed.category === "string" ? parsed.category : "normal",
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}
