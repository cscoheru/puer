import { prisma } from "@/lib/prisma";
import {
  deepseekTarget,
  callLLM,
  chatFallbackTargets,
} from "@/lib/llm-provider";

/**
 * 内容审核:本地敏感词 → AI(DeepSeek)→ 故障转人工 三层闸。
 * 决策三种:publish(直接发布) / review(进待审队列) / reject(直接拒绝提交)。
 * 策略(用户锁定):
 *  - 命中本地敏感词 → 直接 reject(本站只做真实茶品茶器交流,违规词在源头拦死,不浪费人工审核)
 *  - AI 放行 + 可疑送审(AI 判定违规或把握不足 → review)
 *  - AI 故障/超时 → fail-closed 送人工
 *
 * 2026-11-06: MiniMax 账号终止 → DeepSeek（同一 OpenAI 兼容形状）。
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

  // 2) AI 层:DeepSeek 分类(Ark Agent Plan 兜底)。无 key 或任何错误 → fail-closed 送审。
  // trim 与 target 工厂同口径：纯空白 key 不算配置，否则会在 callLLM 里被当无 key 跳过。
  if (!process.env.DEEPSEEK_API_KEY?.trim() && !process.env.ARK_API_KEY?.trim()) {
    return {
      decision: "review",
      categories: [],
      confidence: 0,
      reason: "AI 未配置(DEEPSEEK_API_KEY / ARK_API_KEY 均缺失),转人工",
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
  } catch (e) {
    return {
      decision: "review",
      categories: [],
      confidence: 0,
      // P2-R24：附上错误详情（如 "DeepSeek 402: ..." 余额不足），审核台可直接看到送审原因
      reason: `AI 调用失败,转人工: ${e instanceof Error ? e.message.slice(0, 100) : "unknown"}`,
      source: "fallback",
    };
  }
}

// ─── AI 调用(DeepSeek主力 + 重试, Ark Agent Plan 兜底) ───────────────────────
// JSON 由 prompt 约束 + parseJsonLoose 兜底。调用参数统一在参考实现里,
// 各管线不再各写一份 fetch(R25 半切换事故的根因)。
//
// 兜底顺序:DeepSeek(配额/限流原地重试) → Ark Agent Plan。
// 2026-11-12 按站长要求收敛为两家:GLM 与 lilith 本地兜底已下线,
// 两家都不可用时直接 fail-closed 转人工(本函数抛错由 screenContent 接住)。
// Ark 没配 key 时 chatFallbackTargets() 返回空数组,callLLM 自动只打主力。
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

  const res = await callLLM(deepseekTarget(), prompt, {
    maxTokens: 200,
    timeoutMs: AI_TIMEOUT_MS,
    retries: 2,
    backoffMs: [1500, 5000],
    // 规范降级链的唯一来源（R28 规则 1）：配了 Ark key 就是 [ark]，没配就是 []。
    fallbacks: chatFallbackTargets(),
  });

  const parsed = (res.content ?? {}) as Record<string, unknown>;
  const confidence = Number(parsed.confidence);
  return {
    category: typeof parsed.category === "string" ? parsed.category : "normal",
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}
