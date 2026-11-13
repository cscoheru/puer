/**
 * 小红书钩子文案生成:把论坛精华帖改写成小红书风格的「大白话钩子」。
 * 返回 {hookTitle, caption, tags} 供发布包后台一键复制 → 手动发小红书。
 *
 * 2026-11-06: MiniMax 账号终止 → DeepSeek(同一 DEEPSEEK_API_KEY)。
 * 2026-11-12: 接入规范降级链 DeepSeek → Ark Agent Plan（两家，GLM 已下线），
 * DeepSeek 配额耗尽时文案功能不再直接失败。请求参数与重试/降级
 * 全部由唯一参考实现 `src/lib/llm-provider.ts` 负责（AGENTS.md R27 规则 3）。
 */

import { callLLM, deepseekTarget, chatFallbackTargets } from "./llm-provider";

export interface XhsCopy {
  hookTitle: string; // <20 字钩子标题(悬念/惊喜,不夸张)
  caption: string; // 50-100 字口语正文
  tags: string[]; // 3-5 个标签关键词(不带 #)
}

// 请求路径上的单次超时：本路由落进 nginx 60s proxy_read_timeout，后面还排着
// ffmpeg 视频生成，LLM 段必须按两跳各 25s 收口（2×25=50s < 60s，与
// /api/ai/compose 同口径）。文案 prompt 长且发散，8s 会误杀，25s 仍留足余量。
const TIMEOUT_MS = 25_000;

/**
 * @param title    原帖标题
 * @param htmlContent 原帖正文(HTML,会先剥标签再喂给模型)
 * @throws 两家供应商都没配 key，或整条链调用失败/超时/返回非 JSON
 */
export async function generateXhsCopy(
  title: string,
  htmlContent: string
): Promise<XhsCopy> {
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

  // json 默认 true：callLLM 内部已用 parseJsonLoose 解析，返回的 content 即对象。
  // Ark target 的 jsonMode=false 时不带 response_format，靠 prompt 约束 + 同一兜底解析。
  // retries:0：主力只打 1 发，配额/5xx 秒回后直接降级 Ark，不在请求路径上做
  // 原地重试 —— 否则 2×25s + 退避 + 25s 兜底会到 77s，撑爆 nginx 60s。
  const result = await callLLM(deepseekTarget(), prompt, {
    maxTokens: 600,
    timeoutMs: TIMEOUT_MS,
    temperature: 0.9,
    retries: 0,
    fallbacks: chatFallbackTargets(),
  });

  const parsed = (result.content ?? {}) as {
    hookTitle?: unknown;
    caption?: unknown;
    tags?: unknown;
  };

  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((t) => typeof t === "string").slice(0, 5)
    : [];

  return {
    hookTitle: String(parsed.hookTitle || title).slice(0, 200),
    caption: String(parsed.caption || "").slice(0, 1000),
    tags,
  };
}
