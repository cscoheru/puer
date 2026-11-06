/**
 * 小红书钩子文案生成:把论坛精华帖改写成小红书风格的「大白话钩子」。
 * 返回 {hookTitle, caption, tags} 供发布包后台一键复制 → 手动发小红书。
 *
 * 请求参数由 `src/lib/llm-provider.ts` 的 `buildChatBody` 统一构造
 *（AGENTS.md R27 规则 3：供应商参数只有一份实现）。
 * 2026-11-06: MiniMax 账号终止 → DeepSeek(同一 DEEPSEEK_API_KEY)。
 */

import { deepseekTarget, buildChatBody, parseJsonLoose } from "./llm-provider";

export interface XhsCopy {
  hookTitle: string; // <20 字钩子标题(悬念/惊喜,不夸张)
  caption: string; // 50-100 字口语正文
  tags: string[]; // 3-5 个标签关键词(不带 #)
}

const TIMEOUT_MS = 30_000; // 文案生成比审核慢(prompt 长 + 发散),8s 会误杀

/**
 * @param title    原帖标题
 * @param htmlContent 原帖正文(HTML,会先剥标签再喂给模型)
 * @throws 无 DEEPSEEK_API_KEY 或 API 调用失败/超时/返回非 JSON
 */
export async function generateXhsCopy(
  title: string,
  htmlContent: string
): Promise<XhsCopy> {
  const target = deepseekTarget();
  if (!target.apiKey) {
    throw new Error("DEEPSEEK_API_KEY 未配置,无法生成小红书文案");
  }

  const plain = (htmlContent || "").replace(/<[^>]*>/g, "").slice(0, 800);

  const prompt = `你是小红书爆款文案写手,擅长用大白话钩子吸引真实茶友点击(不标题党、不浮夸)。下面是一篇普洱茶论坛的精华帖子,请改写成小红书发布文案。

原帖标题:${title}
原帖内容(供参考,需改写不要照抄):
${plain}

要求:
1. hookTitle:不超过20字的钩子标题,带悬念或具体感官/时间细节(如"这茶喝完我愣了好几秒""存了十年的生普开汤记"),不要堆感叹号,不要"震惊""绝了""yyds"等夸张词
2. caption:50-100字口语正文,像跟朋友聊天分享体验,可带1-2个emoji,自然不生硬,不要硬广,不要放任何链接或联系方式
3. tags:3-5个小红书搜索标签关键词(不带#号,如["普洱茶","老茶客","茶生活"]),覆盖茶友真实会搜的词

严格按以下JSON返回(不要markdown代码块、不要任何解释):
{"hookTitle":"标题","caption":"正文","tags":["标签1","标签2"]}`;

  const res = await fetch(target.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${target.apiKey}`,
    },
    body: JSON.stringify(
      buildChatBody(target, [{ role: "user", content: prompt }], {
        maxTokens: 600,
        temperature: 0.9,
        json: true,
      })
    ),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`DeepSeek ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const text: string = data?.choices?.[0]?.message?.content || "";

  let parsed: { hookTitle?: unknown; caption?: unknown; tags?: unknown };
  try {
    parsed = parseJsonLoose(text) as typeof parsed;
  } catch {
    throw new Error("DeepSeek 返回非 JSON,无法解析文案");
  }

  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((t) => typeof t === "string").slice(0, 5)
    : [];

  return {
    hookTitle: String(parsed.hookTitle || title).slice(0, 200),
    caption: String(parsed.caption || "").slice(0, 1000),
    tags,
  };
}
