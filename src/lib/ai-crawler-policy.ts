/**
 * AI 爬虫策略（PRD v0.3 §8 + §11 决策 5）。
 *
 * 决策：屏蔽训练类，放行搜索类。
 *
 * 名单来源与核实状态（2026-10-21 核实）：
 *   ✓ Anthropic —— support.anthropic.com/en/articles/8896518（页面标注更新于
 *     2026-04-07）：ClaudeBot=模型训练、Claude-SearchBot=搜索索引、
 *     Claude-User=用户触发。逐条核实。
 *   ✓ Apple —— support.apple.com/en-us/119829：Applebot=搜索爬虫、
 *     Applebot-Extended=生成式基础模型训练（其提供的退订开关）。核实。
 *   · OpenAI / Google —— 本机出口被 Cloudflare 拦截，未能拉取官方页；这两个
 *     token 由 PRD 正文点名（GPTBot / Google-Extended），按业界公开文档实施。
 *
 * **下次调整名单前请重新核对官方页**：
 *   platform.openai.com/docs/bots
 *   developers.google.com/search/docs/crawling-indexing/overview-google-crawlers
 *
 * 重要：robots.txt 只是声明，无法强制执行（PRD §8 原话）。真正的防线是限速 +
 * 防盗链 + 原图私有化。
 */

/** 训练类爬虫：整体拒绝。 */
export const AI_TRAINING_CRAWLERS = [
  "GPTBot",              // OpenAI —— 模型训练
  "ClaudeBot",           // Anthropic —— 模型训练
  "Google-Extended",     // Google —— Gemini / Vertex AI 训练与 Grounding
  "Applebot-Extended",   // Apple —— 生成式基础模型训练
  "CCBot",               // Common Crawl —— 被大量模型用作语料
  "anthropic-ai",        // Anthropic 旧 token，仍在部分文档中列出
  "Bytespider",          // 字节跳动
  "meta-externalagent",  // Meta
  "AI2Bot",              // AI2
  "Diffbot",             // 语义爬虫
  "omgili",              // 爬虫集群
  "Timpibot",            // Pangu / Tinp
] as const;

/**
 * 搜索与引用类爬虫：明确放行，避免日后有人改 `*` 规则时误伤搜索流量。
 * 未列出的爬虫走 `*` 规则（同样放行）—— 显式列出只是把「放行」这条决策
 * 写进文件，不是额外的许可。
 */
export const AI_SEARCH_CRAWLERS = [
  "OAI-SearchBot",       // OpenAI —— 搜索索引
  "ChatGPT-User",        // OpenAI —— 用户触发
  "Claude-SearchBot",    // Anthropic —— 搜索索引
  "Claude-User",         // Anthropic —— 用户触发
  "Applebot",            // Apple —— 搜索爬虫
] as const;

/** 普通爬虫规则：站内公开内容可抓，管理/接口路径不可抓。 */
export const DEFAULT_DISALLOWED_PATHS = [
  "/api/",
  "/admin/",
  "/login",
  "/register",
  "/settings",
  "/forum/search",
  "/forum?page=",
] as const;

export interface RobotsRule {
  userAgent: string;
  allow?: string[];
  disallow?: string[];
}

/**
 * 组装 robots.txt 的规则组。
 *
 * 顺序有意义：robots.txt 按 user-agent 分组独立匹配，某个 UA 同时命中两组时
 * 取 user-agent 串更长的那组。所以同一个 token 绝不能既在训练列表又在放行
 * 列表里 —— 那样两条规则会合并，"最具体者胜" 的判定就变得没意义。
 */
export function buildRobotsRules(): RobotsRule[] {
  return [
    ...AI_TRAINING_CRAWLERS.map((userAgent) => ({ userAgent, disallow: ["/"] })),
    ...AI_SEARCH_CRAWLERS.map((userAgent) => ({ userAgent, allow: ["/"] })),
    { userAgent: "*", allow: ["/"], disallow: [...DEFAULT_DISALLOWED_PATHS] },
  ];
}
