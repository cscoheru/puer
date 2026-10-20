/**
 * 「PentAGI 检索成果 → 论坛草稿」的**纯决策逻辑**（零导入、无 DB、无 `@/` 别名）。
 *
 * 拆成纯函数是照抄 `tasting-note-plan.ts` 的既有约定：那个模块的注释写得很直白
 * ——「zero imports」。原因是双向的：`npm run test:unit` 用的 `node --test` 在 ESM 下
 * 不解析无扩展名的相对导入，而 Next/Turbopack 对同一批文件的解析规则又与它不同。
 * 零导入是唯一两边都安全的写法。IO 与 DB 在 `scripts/ai-news-draft.mjs`。
 *
 * 与品鉴草稿链路（`src/lib/tea-drafts/`）刻意分开：
 *  - 那边的主键前缀是 `tasting-draft_`，后台「🔄 重写」按钮会拿它反查品鉴笔记；
 *    资讯稿走的是另一条路（外部资讯 → 改写 → 草稿），主键前缀必须是 `news-draft_`，
 *    否则后台会对资讯稿跑品鉴改写流程。
 *  - 那边有 `Article.aiOriginal` 双轨（AI 原版 vs 人工改后）做「⚠ 待重写」徽章；
 *    资讯稿一次成型（AI 直出），不存在「待重写」状态，因此不写 `aiOriginal`。
 *
 * 本模块只做「文本 → 素材」的解析与筛选，**不做任何 AI 调用**。文件读取由脚本负责，
 * 解析器只接收字符串。
 */

/**
 * 资讯草稿主键前缀。
 *
 * **不得**用 `tasting-draft_`：`src/app/api/drafts/route.ts` 的 `rewriteDraft`
 * 用 `noteIdFromDraftId()` 反查来源品鉴笔记，非该前缀的 id 会返回
 * 400「非茶记草稿，无来源笔记」——那是对的行为，但我们要的是资讯稿**根本**
 * 不出现在重写流程里，前缀就是那道闸门。
 */
export const NEWS_DRAFT_ID_PREFIX = "news-draft_";

/** 是否是资讯草稿管线产出的帖子。 */
export function isNewsDraftId(id: string): boolean {
  return typeof id === "string" && id.startsWith(NEWS_DRAFT_ID_PREFIX);
}

/** 素材来源类型。决定版块路由与改写 prompt 的口吻。 */
export type MaterialKind = "market" | "tasting" | "knowledge";

/** 版块路由结果。值是 Board.slug，**不是** id（id 由调用方查库取得）。 */
export type BoardRoute = "trade" | "puer" | "knowledge";

/**
 * 一条可用素材。
 *
 * `url` 允许为空：PentAGI 走 Tavily 时，返回的 URL 在**入库前**就被上游脱敏成
 * `§*HTTP/HTTPS URL*§ Name Enhanced*§.com/...`（已查 DB 确认不是导出环节引入）。
 * 这类素材仍可用——平台 / 标题 / 作者 / 发布时间 / 正文都是完整的——只是引用时
 * 只能写「平台 + 标题 + 发布日期」而不能给链接。
 */
export interface Material {
  /** 稳定来源键：用于生成确定性主键与去重。同一条素材每次解析必须得到同一个值。 */
  sourceKey: string;
  /** 标题。可能为空（少数结果块没有标题行）。 */
  title: string;
  /** 原始 URL；被上游脱敏或缺失时为空串。 */
  url: string;
  /** 平台名（如「爱普茶网」「网易号/大益行情网」）；未知时为空串。 */
  platform: string;
  /** 作者；未知时为空串。 */
  author: string;
  /** 发布日期原文（如 `2019-11-22`）；上游没给或我们不确定时为空串。 */
  publishedAt: string;
  /** 正文纯文本（已去 HTML 与 markdown 标记）。 */
  body: string;
  /** 素材类型。 */
  kind: MaterialKind;
}

/** 素材的最小正文长度（字符）。低于此值视为「只有标题没有内容」，不可成帖。 */
export const MIN_BODY_LENGTH = 120;

/**
 * 素材正文的最大长度（字符）。超出的部分截断。
 *
 * 不是为了省 token，而是因为**太长的素材不能成帖**：实测 flow 23 里有一条
 * 大益行情网的完整报价表（37 个茶品 + 价格，1.25 万字），整篇塞进 prompt 会
 * 顶穿上下文，模型只能截尾——截出来的往往是表格中段，价格与批次错配。
 * 截断保留前部（行情综述与要点通常在开头），并由改写层的接地校验兜住数字。
 */
export const MAX_BODY_LENGTH = 6000;

/** 素材标题的最大长度（字符）。`Article.title` 是 `@db.VarChar(200)`，留出余量。 */
export const MAX_TITLE_LENGTH = 60;

/**
 * 茶相关关键词。用于质量闸的第一道：非茶主题（泛生活、AI、数码……）直接丢弃。
 *
 * 刻意放宽但**不放单字「茶」**：单个「茶」字在无关文本里太容易偶然命中——
 * 实测一条娱乐稿的评论区里有用户昵称「代表月亮消灭茶」，单字匹配就把它放进了
 * 茶市。这里只用「茶 + 另一个字」的组合词，漏一条真茶讯的代价远小于放进一条
 * 娱乐帖污染版块。
 */
const TEA_KEYWORDS = [
  "普洱", "大益", "熟茶", "生茶", "古树", "冰岛", "班章", "易武", "临沧",
  "勐库", "景迈", "老班章", "茶饼", "茶膏", "茶汤", "生津", "回甘", "仓储",
  "苦底", "喉韵", "汤色", "年份", "批次", "山头", "春茶", "白茶", "红茶", "熟普",
  "生普", "毛料", "拼配", "单株", "老茶", "新茶", "陈皮", "柑普", "宫廷", "贡茶",
  "茶市", "茶行", "茶商", "茶友", "茶器", "盖碗", "投茶", "醒茶", "出汤",
  "千羽孔雀", "生肖饼", "力开天地", "印象版纳", "七星", "茶青", "晒青", "杀青",
];

/** 市场/行情类信号。命中即路由到「茶市风云」。 */
const MARKET_SIGNALS = [
  "价格", "报价", "行情", "涨", "跌", "回调", "上涨", "下跌", "走高", "走低",
  "成交", "交价", "交易", "期货", "现货", "挂牌", "配货", "打新", "申购", "流通",
  "市值", "估值", "投资", "收藏价值", "溢价", "抄底", "接盘", "抛售", "炒作",
  "市场", "销路", "走量", "缺口", "供给", "需求",
];

/** 口感/品鉴类信号。命中即路由到「普洱醇香」。 */
const TASTING_SIGNALS = [
  "口感", "香气", "汤色", "回甘", "生津", "喉韵", "滋味", "苦涩", "化开", "挂杯",
  "叶底", "条索", "金毫", "开汤", "冲泡", "盖碗", "醒茶", "闷蒸", "出汤",
  "品鉴", "开饼", "熟普", "生普", "存放", "干仓", "湿仓",
];

/** 知识类信号：工艺 / 仓储 / 标准 / 术语。 */
const KNOWLEDGE_SIGNALS = [
  "工艺", "制茶", "晒青", "杀青", "揉捻", "蒸压", "石模", "手工", "拼配", "渥堆",
  "仓储", "退仓", "陈化", "标准", "术语", "定义", "区别", "工序", "等级", "认证",
  "法规", "监管", "协会", "研究", "科学", "成分", "微生物", "机理",
];

/**
 * 把一条素材路由到版块。
 *
 * 优先级是**市场 > 品鉴 > 知识**：一篇同时含价格与口感的稿件，用户要看的是行情
 * （「茶市风云」就是干这个的），放错版块比放错文风更糟。都不命中则按知识类处理
 * ——「习茶问道」是兜底版块，不是垃圾桶（泛生活内容已被 `isPublishable` 的
 * 茶关键词闸挡掉）。
 */
export function routeBoard(m: Pick<Material, "title" | "body" | "kind">): BoardRoute {
  if (m.kind === "market") return "trade";
  const text = `${m.title} ${m.body}`;
  if (containsAny(text, MARKET_SIGNALS)) return "trade";
  if (m.kind === "tasting") return "puer";
  if (containsAny(text, TASTING_SIGNALS)) return "puer";
  if (containsAny(text, KNOWLEDGE_SIGNALS)) return "knowledge";
  return "knowledge";
}

/** 关键词命中判定（大小写不敏感）。 */
function containsAny(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

/**
 * 质量闸：这条素材能不能变成帖子。
 *
 * 四道：
 *  1. 有标题；
 *  2. 茶相关（否则是泛生活内容）；
 *  3. 正文长度够（低于 `MIN_BODY_LENGTH` 说明只抓到了导航条/摘要片段）；
 *  4. 不是已处理过的重复素材（由调用方传入已处理键集合）。
 *
 * **顺序有讲究**：茶相关排在长度前面。两者同时不满足时，「非茶主题」比
 * 「正文过短」更有诊断价值——拒绝原因要写进日志供人排查，一条既非茶又短的
 * 素材如果报「正文过短」，会让人去查长度阈值，而真正该问的是「这玩意儿跟茶
 * 有什么关系」。
 */
export function isPublishable(
  m: Material,
  alreadyProcessed?: ReadonlySet<string>,
): { ok: true } | { ok: false; reason: string } {
  if (!m.title.trim()) return { ok: false, reason: "缺少标题" };
  if (!containsAny(`${m.title} ${m.body}`, TEA_KEYWORDS)) {
    return { ok: false, reason: "非茶主题" };
  }
  if (m.body.length < MIN_BODY_LENGTH) {
    return { ok: false, reason: `正文过短 ${m.body.length}<${MIN_BODY_LENGTH}` };
  }
  if (alreadyProcessed?.has(m.sourceKey)) {
    return { ok: false, reason: "素材已处理" };
  }
  return { ok: true };
}

/**
 * 确定性主键：`news-draft_` + 来源键的 64 位哈希。
 *
 * 幂等性完全靠 Article 主键：同一份素材重复跑会撞 PK（Prisma P2002），
 * 调用方按「已存在」跳过。**不能**用随机 id，否则每周重跑会灌出重复帖。
 *
 * 哈希用两轮 FNV-1a 32 位（不同种子）拼成 64 位，而不是 `node:crypto` 的 sha256：
 * 本模块是零导入的纯函数，而 `src/lib/` 下其他纯决策模块都不引 node 内建
 * （`uid.ts` 那类引 `@/lib/prisma` 的是 IO 模块，规则不同）。64 位空间的生日
 * 悖论碰撞率在「每周几十条 × 十年」量级下低于百万分之一。
 */
export function draftId(sourceKey: string): string {
  return `${NEWS_DRAFT_ID_PREFIX}${fnv1a32(sourceKey, 0x811c9dc5)}${fnv1a32(sourceKey, 0x01000193)}`;
}

/** FNV-1a 32 位哈希，输出 8 位十六进制。`seed` 初始偏移基。 */
function fnv1a32(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32 位环绕：JS 位运算是 32 位有符号，用 >>> 0 归一到无符号。
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ── 解析器 ──────────────────────────────────────────────────────────

/**
 * 解析 Tavily 合成答案文件（`raw/03-tavily-answers.md`）。
 *
 * 块结构（成果包生成器产出的固定格式）：
 *
 * ```
 * ### 来源1 | 平台：爱普茶网（P0，2001批次官方品鉴）
 * - **URL**：https://example.com/show-15-2788.html
 * - **标题**：四海之内皆兄弟：「沧海」80周年特别纪念版即将上市
 * - **作者**：益友会（经大益授权发布）
 * - **发布时间**：2020-10-30
 * - **覆盖批次**：2001（80周年纪念）
 * - **核心要点**：
 *   - **规格**：357g/饼；7饼/提
 *   ...
 * ```
 *
 * 平台名后面括号里是检索质量标注（`P0` 等），不是平台名的一部分，解析时剥掉。
 */
export function parseTavilyAnswers(text: string): Material[] {
  const materials: Material[] = [];
  // 以 `### 来源` 开头切块；`## msglog` 之类的一级/二级标题天然成为块前缀被丢掉。
  const blocks = text.split(/^###\s+来源/m).slice(1);
  for (const raw of blocks) {
    // 切块后要再按二级标题截断：`### 来源` 只保证**下一个来源块**的边界，
    // 而一个 msglog 里的「来源」块后面常跟着 `## 产品基本信息`、`## 稀缺度评估`
    // 这类二级小节（flow 23 的 3740 就是），不截断的话最后一个来源块会把
    // 整个 msglog 的剩余内容吞进正文（实测吞出 4.8 万字）。
    const block = cutAtLevel2Heading(raw);
    const lines = block.split("\n");
    // 块首行是 `N | 平台：XXX（标注）`，但 `split` 后标题行已被切走，
    // 所以第一行是标题行的剩余部分。
    const header = lines[0] ?? "";
    const platform = parsePlatform(header);
    const body: string[] = [];
    let title = "";
    let url = "";
    let author = "";
    let publishedAt = "";
    let inBody = false;

    for (const line of lines.slice(1)) {
      const field = /^-\s+\*\*(.+?)\*\*[：:]\s*(.*)$/.exec(line);
      if (field) {
        const key = field[1];
        const value = field[2].trim();
        // 「核心要点」之后是正文（缩进的子项），其余字段都是元信息。
        if (key === "核心要点" || key === "核心内容" || key === "要点") {
          inBody = true;
          continue;
        }
        if (key === "URL") { url = normalizeUrl(value); continue; }
        if (key === "标题") { title = value; continue; }
        if (key === "作者" || key === "来源作者") { author = value; continue; }
        if (key === "发布时间" || key === "发布日期" || key === "时间") { publishedAt = value; continue; }
        continue;
      }
      if (inBody) {
        // 子项形如 `  - **干茶**：经6年自然陈化…`；剥掉 markdown 标记留正文。
        const item = /^\s*-\s+(?:\*\*)?(.+?)(?:\*\*)?[：:]\s*(.*)$/.exec(line);
        if (item) {
          body.push(`${item[1].trim()}：${item[2].trim()}`);
        } else if (line.trim()) {
          body.push(line.replace(/^\s*[-*]\s*/, "").trim());
        }
      }
    }

    const text2 = body.join("\n").trim();
    if (!title && !text2) continue;
    const kind = classifyMaterial(`${title} ${text2}`);
    materials.push({
      sourceKey: buildSourceKey(platform, title, url, publishedAt, text2),
      title: title.trim(),
      url,
      platform,
      author,
      publishedAt,
      body: clampBody(text2),
      kind,
    });
  }
  return materials;
}

/**
 * 解析搜索结果文件（`raw/02-search-results.md`）。
 *
 * 这个文件是**多个 searchlog 段落的拼接**，每个段落头部是：
 *
 * ```
 * ## searchlog 514 — tavily — 2026-10-19 13:24:50.917049+00
 * ```
 *
 * 两种引擎的结果块格式**完全不同**，必须按段落分派解析：
 *
 * Searxng（`## searchlog 513 — searxng — …`）：
 *
 * ```
 * ### 1. 大益行情网 大益普洱茶最新价格 …
 *
 * **URL:** [https://www.dayihangqing.com/](https://www.dayihangqing.com/)
 *
 * **Content:** 回顾：反转只在一瞬间，从昨天的最低点26000到今天最高34500 …
 *
 * **Source Engine:** duckduckgo
 * ```
 *
 * Tavily（`## searchlog 514 — tavily — …`）：
 *
 * ```
 * # Answer
 *
 * （英文合成答案段落）
 *
 * # Links
 *
 * ## 1. 2025年云南普洱春茶价格行情 – 茶中有茗 - 普洱茶
 *
 * * URL https://www.czyma.com/wenzhang/5995.html
 * * Match score 0.930
 *
 * ### Short content
 *
 * 老班章古树茶:6000-13000元/公斤,混采2500-6000元/公斤 …
 * ```
 *
 * 注意 Tavily 的标题是 **二级** 标题（`## N.`）而 Searxng 是 **三级**（`### N.`），
 * 且 Tavily 的 URL 行没有 `**` 包裹。只写一套正则会整段漏掉 Tavily——而 Tavily
 * 恰恰是带**真实可点击 URL** 的市场动态主源，漏了就只剩一堆没链接的摘要。
 */
/**
 * 这个文件有两种来源形态，解析器都必须认：
 *
 * 1. **人工归档版**（docs/research/pu-er-tea-2026-10-19）：段落头是
 *    `## searchlog 514 — tavily — <ts>`，引擎名直接在头里。
 * 2. **export.mjs 自动版**：段落头是 `## searchcall 4101 — answer — <ts>`，
 *    第二个字段是 web_search 的 **mode**（`answer` = Tavily 合成答案 + 链接，
 *    其余 = Searxng 风格）。段体一样含 `# Links` 或 `**Content:**`。
 *
 * 两种段落的正文块格式都由 `parseTavilyLinkBlocks` / `parseSearxngBlocks`
 * 处理，差别只在「怎么切段、怎么判定引擎」。
 */
export function parseSearchResults(text: string): Material[] {
  const materials: Material[] = [];
  // 同时切 `## searchlog …` 与 `## searchcall …` 两种段落头。
  const segments = text.split(/^##\s+(?:searchlog|searchcall)\s+/m).slice(1);
  for (const segment of segments) {
    const header = segment.split("\n")[0] ?? "";
    // searchlog 看引擎名（tavily）；searchcall 看 mode（answer）。
    const isTavily = /\btavily\b/i.test(header) || /\banswer\b/i.test(header);
    materials.push(...(isTavily ? parseTavilyLinkBlocks(segment) : parseSearxngBlocks(segment)));
  }
  return materials;
}

/** Searxng 结果块：`**URL:** [url](url)` + `**Content:** 正文`。 */
function parseSearxngBlocks(segment: string): Material[] {
  const materials: Material[] = [];
  const blocks = segment.split(/^###\s+\d+\.\s+/m).slice(1);
  for (const block of blocks) {
    const lines = block.split("\n");
    const title = (lines[0] ?? "").trim();
    let url = "";
    let body = "";
    let inContent = false;
    for (const line of lines.slice(1)) {
      if (/^\*\*URL:\*\*/.test(line)) {
        url = normalizeUrl(extractMarkdownLink(line));
        inContent = false;
        continue;
      }
      if (/^\*\*Content:\*\*/.test(line)) {
        inContent = true;
        // `**Content:** 正文` 可能同行，也可能下一行才出现正文。
        const inline = line.replace(/^\*\*Content:\*\*/, "").trim();
        if (inline) body = inline;
        continue;
      }
      if (/^\*\*Source Engine:\*\*/.test(line)) {
        inContent = false;
        continue;
      }
      if (inContent && line.trim()) {
        body += (body ? "\n" : "") + line.trim();
      }
    }
    const text2 = body.trim();
    if (!title && !text2) continue;
    materials.push({
      sourceKey: buildSourceKey("", title, url, "", text2),
      title,
      url,
      platform: "",
      author: "",
      publishedAt: "",
      body: clampBody(text2),
      kind: classifyMaterial(`${title} ${text2}`),
    });
  }
  return materials;
}

/** Tavily 链接块：`## N. 标题` + `* URL https://…` + `### Short content` 正文。 */
function parseTavilyLinkBlocks(segment: string): Material[] {
  const materials: Material[] = [];
  // `# Links` 之后才是真正的链接列表；它之前是英文合成答案段落。
  const linksIdx = segment.indexOf("# Links");
  const linksPart = linksIdx >= 0 ? segment.slice(linksIdx) : segment;
  // 二级标题 `## N. 标题`；`### Short content` 是三级，不匹配。
  const blocks = linksPart.split(/^##\s+\d+\.\s+/m).slice(1);
  for (const block of blocks) {
    const lines = block.split("\n");
    const title = (lines[0] ?? "").trim();
    let url = "";
    let body = "";
    let inContent = false;
    for (const line of lines.slice(1)) {
      if (/^\*\s*URL\s+/i.test(line)) {
        url = normalizeUrl(line.replace(/^\*\s*URL\s+/i, "").trim());
        inContent = false;
        continue;
      }
      if (/^\*\s*Match score/i.test(line)) continue;
      if (/^###\s+Short content/i.test(line)) {
        inContent = true;
        continue;
      }
      // 下一个块的标题行（`## N. `）已被 split 切走，剩余的 `**` 粗体行是正文续行。
      if (inContent && line.trim()) {
        body += (body ? "\n" : "") + line.trim();
      }
    }
    const text2 = body.trim();
    if (!title && !text2) continue;
    materials.push({
      sourceKey: buildSourceKey("", title, url, "", text2),
      title,
      url,
      platform: "",
      author: "",
      publishedAt: "",
      body: clampBody(text2),
      kind: classifyMaterial(`${title} ${text2}`),
    });
  }
  return materials;
}

/**
 * 正文截断到 `MAX_BODY_LENGTH`。
 *
 * 在**行边界**截断而非字符边界：markdown 表格与列表按行才读得懂，断在半行会
 * 产出「| 37 | 501 0562」这种残行，模型会当成一条不完整的报价。
 */
function clampBody(body: string): string {
  if (body.length <= MAX_BODY_LENGTH) return body;
  const lines = body.split("\n");
  let out = "";
  for (const line of lines) {
    if (out.length + line.length + 1 > MAX_BODY_LENGTH) break;
    out += (out ? "\n" : "") + line;
  }
  return out || body.slice(0, MAX_BODY_LENGTH);
}

/**
 * 在第一个二级标题（`## `）处截断文本。
 *
 * 用于把「来源块」与它后面的小节分开：成果包里 `### 来源N` 是三级标题，
 * 而 `## 产品基本信息`、`## 稀缺度评估` 是二级。不截断的话，最后一个来源块
 * 会把整个 msglog 的余下内容当成自己的正文——实测吞进 4.8 万字，
 * 远超任何合理的 prompt 长度。
 */
function cutAtLevel2Heading(text: string): string {
  const m = /^##\s+/m.exec(text);
  return m ? text.slice(0, m.index) : text;
}

/**
 * 剥平台名尾部的检索质量标注：`爱普茶网（P0，2001批次官方品鉴）` → `爱普茶网`。
 *
 * 括号里是检索侧给的证据强度标注（P0 = 最可信），对改写 prompt 有用但不属于
 * 「平台」字段——留着会让「来源：爱普茶网（P0，2001批次官方品鉴）」这种话读起来
 * 像平台自己写的括号。
 */
function parsePlatform(header: string): string {
  const m = /平台[：:]\s*([^（(]*)/.exec(header);
  if (!m) return "";
  return m[1].trim();
}

/** 取出 `[url](url)` 或裸 url 里的链接部分。 */
function extractMarkdownLink(line: string): string {
  const m = /\]\((https?:\/\/[^)]+)\)/.exec(line);
  if (m) return m[1];
  const bare = /https?:\/\/\S+/.exec(line);
  return bare ? bare[0] : "";
}

/**
 * 归一化 URL：Markdown 链接去壳；**被上游脱敏的 URL 置空**。
 *
 * Tavily 返回的 URL 里含 `§*HTTP/HTTPS URL*§` 这类占位符时，它已经不能被点击，
 * 留在正文里只会让读者点到坏链。置空后引用方改写「平台 + 标题 + 发布日期」。
 */
function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (value.includes("§") || value.includes("*§")) return "";
  const m = /^https?:\/\//.test(value) ? value : extractMarkdownLink(value);
  if (!m || !/^https?:\/\/[^\s]+$/.test(m)) return "";
  return m;
}

/**
 * 素材分类。决定版块路由与改写口吻。
 *
 * 判定顺序：行情 > 品鉴 > 知识。用 `kind === "market"` 显式命中是因为「价格走势」
 * 这类词在品鉴文里也常出现（收藏价值论证），但只要整篇在讲涨跌就该归市场。
 */
export function classifyMaterial(text: string): MaterialKind {
  if (containsAny(text, MARKET_SIGNALS)) return "market";
  if (containsAny(text, TASTING_SIGNALS)) return "tasting";
  return "knowledge";
}

/**
 * 来源键：标识「同一条素材」。
 *
 * 优先用 URL（同一篇文章在多次检索里 URL 相同），URL 不可用时退回
 * 「平台 + 标题 + 发布日期」。正文**不**进来源键：同一篇文章在不同检索轮次里
 * 正文摘要可能长短不同，用正文做键会导致每周都被当成新素材重复成帖。
 */
export function buildSourceKey(
  platform: string,
  title: string,
  url: string,
  publishedAt: string,
  body: string,
): string {
  if (url) return `u:${url}`;
  const t = title.trim();
  if (t) return `t:${platform}|${t}|${publishedAt.trim()}`;
  // 连标题都没有（极少见）：退化到正文前 80 字的指纹。
  return `b:${platform}|${publishedAt.trim()}|${body.trim().slice(0, 80)}`;
}
