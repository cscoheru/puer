/**
 * 纯单测：`parseTavilyAnswers` / `parseSearchResults` / `routeBoard` /
 * `isPublishable` / `draftId`。
 *
 * fixture 用的是 **PentAGI flow 23 成果包的真实片段**（`raw/02-search-results.md`
 * 与 `raw/03-tavily-answers.md`），不是虚构样本——真实数据才会暴露解析器的真实
 * 边界：Tavily 与 Searxng 的块格式完全不同、Tavily 的 URL 被上游脱敏成
 * `§*HTTP/HTTPS URL*§` 占位符、Tavily 的标题是二级标题而 Searxng 是三级。
 *
 * 锁住的是**不需要数据库就能证明**的业务规则，重点是四条最容易回归的：
 *  - 两种引擎的结果块都要能解析（漏了 Tavily 就只剩没链接的摘要）；
 *  - 被脱敏的 URL 必须置空（留着会让读者点到坏链）；
 *  - 版块路由里「市场 > 品鉴 > 知识」的优先级不能倒（同时含价格与口感的稿
 *    应当进「茶市风云」，不是「普洱醇香」）；
 *  - 资讯草稿主键前缀**绝不能**是 `tasting-draft_`（否则后台会对资讯稿跑品鉴
 *    改写流程）；主键必须确定性（幂等靠主键撞 PK，不靠随机 id）。
 *
 * Run: node --test --test-reporter=spec src/lib/news-draft/plan.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTavilyAnswers,
  parseSearchResults,
  routeBoard,
  isPublishable,
  draftId,
  buildSourceKey,
  classifyMaterial,
  isNewsDraftId,
  NEWS_DRAFT_ID_PREFIX,
  MIN_BODY_LENGTH,
  type Material,
} from "./plan.ts";

// ── 真实成果包片段（flow 23，2026-10-19）────────────────────────────

/** `raw/03-tavily-answers.md` 的一个真实「来源N」块。 */
const TAVILY_BLOCK = `### 来源2 | 平台：爱普茶网（P0，2001批次官方品鉴）
- **URL**：§*HTTP/HTTPS URL*§ Name Enhanced*§.com/show-15-2788.html
- **标题**：四海之内皆兄弟：「沧海」80周年特别纪念版即将上市
- **作者**：益友会（经大益授权发布）
- **发布时间**：2020-10-30
- **覆盖批次**：2001（80周年纪念）
- **核心要点**：
  - **规格**：357g/饼；7饼/提；牛皮纸+中提礼盒
  - **原料**：精选普洱茶核心产区高海拔优质晒青毛茶
  - **官方品质特征**：饼形端正松紧适度，条索肥硕芽叶清晰乌润显毫；汤色橙黄明亮；香气高扬，烟香+陈香显著带蜜香
  - **发售政策**：天猫小黑盒专场3500提/¥23,800；单饼6000饼/¥3,880
`;

/** `raw/02-search-results.md` 的真实 Searxng 块。 */
const SEARXNG_BLOCK = `### 1. 大益行情网 大益普洱茶最新价格 大益行情实时交易报价平台 ...

**URL:** [https://www.dayihangqing.com/](https://www.dayihangqing.com/)

**Content:** 回顾： 反转只在一瞬间，从昨天的最低点26000到今天最高34500，市场现在还存在一定的空单，印象版纳拥抱大益新政策"锁仓"概念运用，逆风翻盘并非无迹可寻。最近几天观察到市场找货的人明显多了，特别是明星品种，例如精品孔雀、群峰、仓颉、轩辕号。2301生肖兔饼，曾最高去到3万出头，如今回调到1.5万左右。

**Source Engine:** duckduckgo
`;

/** `raw/02-search-results.md` 的真实 Tavily 块（`# Links` 下的二级标题）。 */
const TAVILY_LINK_BLOCK = `# Answer

According to the sources, the price range for 2025 ancient tree Pu'er tea varies significantly across regions.

# Links

## 1. 2025年云南普洱春茶价格行情– 茶中有茗 - 普洱茶

* URL https://www.czyma.com/wenzhang/5995.html
* Match score 0.930

### Short content

老班章古树茶:6000-13000元/公斤,混采2500-6000元/公斤,小树:1000-1500元/公斤。新班章古树茶:2500-5000元/公斤。
`;

// ── Tavily 合成答案解析 ─────────────────────────────────────────────

test("parseTavilyAnswers: 解析出标题/平台/作者/日期/正文", () => {
  const ms = parseTavilyAnswers(TAVILY_BLOCK);
  assert.equal(ms.length, 1);
  const m = ms[0]!;
  assert.equal(m.title, "四海之内皆兄弟：「沧海」80周年特别纪念版即将上市");
  assert.equal(m.platform, "爱普茶网");
  assert.equal(m.author, "益友会（经大益授权发布）");
  assert.equal(m.publishedAt, "2020-10-30");
});

test("parseTavilyAnswers: 平台名剥掉检索质量标注（P0 等）", () => {
  const m = parseTavilyAnswers(TAVILY_BLOCK)[0]!;
  // 括号里是检索侧的证据强度标注，不属于平台名。
  assert.ok(!m.platform.includes("P0"), `平台名残留标注: ${m.platform}`);
  assert.ok(!m.platform.includes("（"), `平台名残留括号: ${m.platform}`);
});

test("parseTavilyAnswers: 被上游脱敏的 URL 置空（否则读者点到坏链）", () => {
  const m = parseTavilyAnswers(TAVILY_BLOCK)[0]!;
  assert.equal(m.url, "");
  // 置空后仍要用标题+平台+日期做来源键，不能因此丢素材。
  assert.ok(m.sourceKey.startsWith("t:"), `来源键退化错误: ${m.sourceKey}`);
});

test("parseTavilyAnswers: 正文收进核心要点，且带上字段名", () => {
  const m = parseTavilyAnswers(TAVILY_BLOCK)[0]!;
  assert.ok(m.body.includes("规格：357g/饼"), `正文缺字段名: ${m.body}`);
  assert.ok(m.body.includes("发售政策"), `正文缺末条要点: ${m.body}`);
  // markdown 标记必须剥掉。
  assert.ok(!m.body.includes("**"), `正文残留 markdown 粗体: ${m.body}`);
});

test("parseTavilyAnswers: 数字原样保留（接地校验的输入）", () => {
  const m = parseTavilyAnswers(TAVILY_BLOCK)[0]!;
  assert.ok(m.body.includes("357"), "规格数字丢失");
  assert.ok(m.body.includes("23,800"), "发售价格数字丢失");
});

test("parseTavilyAnswers: 来源块不吞掉后续二级小节（实测吞出 4.8 万字）", () => {
  // flow 23 的 msglog 3740：最后一个「来源」块后面跟着 `## 产品基本信息`、
  // `## 稀缺度评估` 两个二级小节。不按二级标题截断的话，它们会全进最后一个
  // 来源块的正文。
  const text = `### 来源1 | 平台：爱普茶网（P0）
- **URL**：§*HTTP/HTTPS URL*§ Name Enhanced*§.com/a.html
- **标题**：某茶的品鉴记录
- **发布时间**：2020-10-30
- **核心要点**：
  - **干茶**：条索肥硕

## 产品基本信息

这是另一个小节的内容，不属于上面的来源块。

## 稀缺度评估

又一个不属于来源块的小节。
`;
  const ms = parseTavilyAnswers(text);
  assert.equal(ms.length, 1);
  assert.ok(!ms[0]!.body.includes("产品基本信息"), "正文吞掉了后续小节标题");
  assert.ok(!ms[0]!.body.includes("稀缺度评估"), "正文吞掉了后续小节内容");
  assert.ok(ms[0]!.body.includes("条索肥硕"), "正文丢了本块的核心要点");
});

test("parseTavilyAnswers: 超长正文被截断（整篇报价表会顶穿 prompt）", () => {
  const long = "普洱茶报价表行，批次与价格。".repeat(600); // 远大于上限
  const text = `### 来源1 | 平台：大益行情网（P0）
- **URL**：https://example.com/a.html
- **标题**：大益报价表
- **发布时间**：2026-01-08
- **核心要点**：
  - **明细**：${long}
`;
  const m = parseTavilyAnswers(text)[0]!;
  assert.ok(m.body.length <= 6000, `正文未截断: ${m.body.length}`);
});

test("parseTavilyAnswers: 截断不切出残行（半行会让模型误读价格）", () => {
  // 真实场景：正文是 markdown 表格，断在半行会产出「| 37 | 501 0562」这种
  // 残行，模型会把它当成一条完整报价。
  const rows = Array.from({ length: 2000 }, (_, i) => `| ${i} | 批次${i} | 2005年 | ￥${1000 + i}.00 |`).join("\n");
  const text = `### 来源1 | 平台：某网（P0）
- **URL**：https://example.com/a.html
- **标题**：表格类素材
- **发布时间**：2026-01-08
- **核心要点**：
  - **明细**：
${rows}
`;
  const m = parseTavilyAnswers(text)[0]!;
  assert.ok(m.body.length <= 6000, `正文未截断: ${m.body.length}`);
  // 截断后的最后一行必须是完整的一行（以 `|` 开头也以 `|` 结尾），
  // 不能是表格单元格的中间截断。
  const lastLine = m.body.trim().split("\n").pop() ?? "";
  assert.ok(lastLine.startsWith("|") && lastLine.endsWith("|"), `残行: ${lastLine.slice(-40)}`);
});

test("parseTavilyAnswers: 单行超长时整行丢弃而不是切半行", () => {
  // 没有换行的超长段落：按行截断会把这行整行丢掉（宁可少一行，
  // 也不能给模型一个半截的价格数字）。
  const huge = "x".repeat(20000);
  const text = `### 来源1 | 平台：某网（P0）
- **URL**：https://example.com/a.html
- **标题**：超长单行
- **发布时间**：2026-01-08
- **核心要点**：
  - **明细**：${huge}
`;
  const m = parseTavilyAnswers(text)[0]!;
  assert.ok(m.body.length <= 6000, `正文未截断: ${m.body.length}`);
});

// ── 搜索结果解析（两种引擎）─────────────────────────────────────────

test("parseSearchResults: Searxng 块解析出标题/URL/正文", () => {
  const text = `## searchlog 513 — searxng — 2026-10-19 13:22:04.935383+00

${SEARXNG_BLOCK}`;
  const ms = parseSearchResults(text);
  assert.equal(ms.length, 1);
  const m = ms[0]!;
  assert.ok(m.title.startsWith("大益行情网"), `标题错: ${m.title}`);
  assert.equal(m.url, "https://www.dayihangqing.com/");
  assert.ok(m.body.includes("26000"), "价格数字丢失");
  assert.ok(m.body.includes("生肖兔饼"), "正文丢失");
});

test("parseSearchResults: Tavily 块也解析出真实 URL（不能整段漏掉）", () => {
  const text = `## searchlog 514 — tavily — 2026-10-19 13:24:50.917049+00

${TAVILY_LINK_BLOCK}`;
  const ms = parseSearchResults(text);
  assert.equal(ms.length, 1);
  const m = ms[0]!;
  assert.ok(m.title.includes("云南普洱春茶价格行情"), `标题错: ${m.title}`);
  assert.equal(m.url, "https://www.czyma.com/wenzhang/5995.html");
  assert.ok(m.body.includes("6000-13000"), "价格区间丢失");
});

test("parseSearchResults: 同一文件里的两种引擎都解析（混合段落）", () => {
  const text = [
    `## searchlog 513 — searxng — 2026-10-19 13:22:04.935383+00`,
    SEARXNG_BLOCK,
    `## searchlog 514 — tavily — 2026-10-19 13:24:50.917049+00`,
    TAVILY_LINK_BLOCK,
  ].join("\n");
  const ms = parseSearchResults(text);
  assert.equal(ms.length, 2, `应解析出 2 条，实得 ${ms.length}`);
  assert.ok(ms.some((m) => m.url === "https://www.dayihangqing.com/"));
  assert.ok(ms.some((m) => m.url === "https://www.czyma.com/wenzhang/5995.html"));
});

test("parseSearchResults: 英文合成答案段落不被当成结果块", () => {
  const text = `## searchlog 514 — tavily — 2026-10-19 13:24:50.917049+00

# Answer

According to the sources, the price range varies significantly across regions and specific teas.

# Links

## 1. 某价格行情

* URL https://example.com/a.html
* Match score 0.9

### Short content

正文内容在这里，长度足够。
`;
  const ms = parseSearchResults(text);
  assert.equal(ms.length, 1);
  assert.equal(ms[0]!.url, "https://example.com/a.html");
});

test("parseSearchResults: 认 export.mjs 自动版的 searchcall 段落头（mode=answer）", () => {
  // 自动导出器的段落头是 `## searchcall <id> — answer — <ts>`，而不是人工版的
  // `## searchlog <id> — tavily — <ts>`。解析器必须两种都认，否则每周自动产出
  // 的成果包会解析出 0 条素材（实测踩过）。
  const text = `## searchcall 4101 — answer — 2026-10-19T13:34:59.525743Z

**Query:** 大益 新品 配货 涨价

**Result:**

# Answer

据来源，大益明星单品价格上涨。

# Links

## 1. 出厂价1.2万现价6000的普洱茶

* URL https://www.sohu.com/a/1084511319_121124457
* Match score 0.91

### Short content

普洱茶金融茶市场近期波动剧烈，大益某明星单品出厂价1.2万元现价6000元，经销商库存压力大，炒茶十几年的品种价格出现明显回调。
`;
  const ms = parseSearchResults(text);
  assert.equal(ms.length, 1, `应解析出 1 条，实得 ${ms.length}`);
  assert.equal(ms[0]!.url, "https://www.sohu.com/a/1084511319_121124457");
  assert.ok(ms[0]!.title.includes("出厂价"), `标题错: ${ms[0]!.title}`);
});

test("parseSearchResults: searchcall 的非 answer 模式按 Searxng 风格解析", () => {
  const text = `## searchcall 4200 — search — 2026-10-19T13:40:00Z

**Query:** 普洱茶 贴吧

**Result:**

### 1. 普洱茶吧-百度贴吧

**URL:** [https://tieba.baidu.com/f?kw=普洱茶](https://tieba.baidu.com/f?kw=普洱茶)

**Content:** 普洱茶吧是茶友交流生茶熟茶新茶老茶的社区，近期热门讨论集中在大益标杆生茶与下关特沱的行情变化。

**Source Engine:** duckduckgo
`;
  const ms = parseSearchResults(text);
  assert.equal(ms.length, 1);
  assert.equal(ms[0]!.url, "https://tieba.baidu.com/f?kw=普洱茶");
  assert.ok(ms[0]!.body.includes("大益标杆生茶"));
});

// ── 版块路由 ────────────────────────────────────────────────────────

test("routeBoard: 含价格/涨跌的进茶市风云", () => {
  const m: Material = {
    sourceKey: "x", title: "大益 2026 行情", url: "", platform: "", author: "",
    publishedAt: "", body: "力开天地散提 ¥5800，跌了500；千羽孔雀涨到10.6万", kind: "market",
  };
  assert.equal(routeBoard(m), "trade");
});

test("routeBoard: 只讲口感的进普洱醇香", () => {
  const m: Material = {
    sourceKey: "x", title: "1901 沧海开汤", url: "", platform: "", author: "",
    publishedAt: "", body: "入口微涩但化开迅速，回甘迅速，喉韵舒适留口，汤色橙黄明亮", kind: "tasting",
  };
  assert.equal(routeBoard(m), "puer");
});

test("routeBoard: 同时含价格与口感的归市场（市场优先）", () => {
  // 收藏价值论证里常写价格，但整篇在讲涨跌 → 读者要的是行情。
  const m: Material = {
    sourceKey: "x", title: "沧海的价格走势", url: "", platform: "", author: "",
    publishedAt: "", body: "期货1.45万→3.7万/提，现货2.85万→3.95万/提。香气高扬，回甘快", kind: "market",
  };
  assert.equal(routeBoard(m), "trade");
});

test("routeBoard: 工艺/仓储类归习茶问道", () => {
  const m: Material = {
    sourceKey: "x", title: "普洱茶的陈化机理", url: "", platform: "", author: "",
    publishedAt: "", body: "晒青毛茶经杀青、揉捻、蒸压成型，仓储过程中的微生物参与风味转化", kind: "knowledge",
  };
  assert.equal(routeBoard(m), "knowledge");
});

// ── 质量闸 ──────────────────────────────────────────────────────────

test("isPublishable: 正常素材通过", () => {
  const m: Material = {
    sourceKey: "x", title: "大益 2026 行情综述", url: "", platform: "", author: "",
    publishedAt: "", body: "普洱茶大益今年的成品价格出现明显分化，明星单品走强而常规系列走弱，茶市整体情绪趋于降温。回顾最近三个月的成交情况，精品孔雀、群峰等明星品种的找货明显增多，而印象版纳之外的多数品种仍处在回调通道里，2301生肖兔饼从最高的3万出头回落到1.5万附近。",
    kind: "market",
  };
  assert.equal(isPublishable(m).ok, true);
});

test("isPublishable: 正文过短拒绝（只抓到导航条）", () => {
  const m: Material = {
    sourceKey: "x", title: "大益行情网", url: "", platform: "", author: "",
    publishedAt: "", body: "大益 中茶 下关沱茶 一头大象", kind: "market",
  };
  const r = isPublishable(m);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason.includes("正文过短"));
});

test("isPublishable: 非茶主题拒绝（泛生活内容）", () => {
  const m: Material = {
    sourceKey: "x", title: "独居青年的一居室改造", url: "", platform: "", author: "",
    publishedAt: "", body: "本文记录了一位独居青年的日常改造过程，从收纳到灯光搭配都做了详细说明，附有大量实拍图片供参考。整体思路是少改动硬装、多用可移动家具，把有限的面积利用起来，改造前后对比明显。",
    kind: "knowledge",
  };
  const r = isPublishable(m);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason.includes("非茶主题"));
});

test("isPublishable: 已处理的素材被拒（幂等的第一道闸）", () => {
  const m: Material = {
    sourceKey: "u:https://example.com/a", title: "大益行情", url: "https://example.com/a",
    platform: "", author: "", publishedAt: "",
    body: "普洱茶成品价格分化明显，明星单品走强，茶市整体情绪降温，茶友需关注批次与年份差异。这一轮回调主要挤掉了前期的泡沫，常规品种的成交活跃度下降，而少数明星单品仍然保持着可观的溢价空间。需要留意的是，不同产区与不同年份的茶品分化正在拉大，同一品牌下不同批次的价差已经明显到不能一概而论，选购时还是得逐个批次看具体报价与仓储状况再做判断。",
    kind: "market",
  };
  const r = isPublishable(m, new Set(["u:https://example.com/a"]));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason.includes("已处理"));
});

test("isPublishable: 缺标题拒绝", () => {
  const m: Material = {
    sourceKey: "x", title: "  ", url: "", platform: "", author: "",
    publishedAt: "", body: "普洱茶价格行情综述，" + "内容".repeat(80), kind: "market",
  };
  assert.equal(isPublishable(m).ok, false);
});

// ── 主键 ────────────────────────────────────────────────────────────

test("draftId: 同一来源键永远得到同一主键（幂等靠它）", () => {
  const a = draftId("u:https://example.com/a");
  const b = draftId("u:https://example.com/a");
  assert.equal(a, b);
  assert.ok(a.startsWith(NEWS_DRAFT_ID_PREFIX));
});

test("draftId: 不同来源键得到不同主键", () => {
  assert.notEqual(draftId("u:https://example.com/a"), draftId("u:https://example.com/b"));
});

test("draftId: 绝不能用 tasting-draft_ 前缀（后台会对资讯稿跑品鉴改写）", () => {
  const id = draftId("u:https://example.com/a");
  assert.ok(!id.startsWith("tasting-draft_"), `前缀错误: ${id}`);
  assert.ok(isNewsDraftId(id), "isNewsDraftId 未识别");
  assert.ok(!isNewsDraftId("tasting-draft_abc"), "isNewsDraftId 误判品鉴草稿");
});

test("draftId: 主键长度可控（不会撞 VarChar 上限）", () => {
  // Article.id 是 String @id（无固定长度），但保持短。
  assert.ok(draftId("x".repeat(5000)).length < 64);
});

// ── 来源键 ──────────────────────────────────────────────────────────

test("buildSourceKey: 有 URL 时用 URL（跨检索轮次稳定）", () => {
  const k1 = buildSourceKey("爱普茶网", "标题A", "https://a.com/1", "2020-10-30", "正文A");
  const k2 = buildSourceKey("爱普茶网", "标题A", "https://a.com/1", "2020-10-31", "完全不同的正文");
  assert.equal(k1, k2, "同一 URL 的不同轮次应视为同一素材");
});

test("buildSourceKey: 无 URL 时退回 平台+标题+日期（不含正文）", () => {
  const k1 = buildSourceKey("爱普茶网", "标题A", "", "2020-10-30", "正文A");
  const k2 = buildSourceKey("爱普茶网", "标题A", "", "2020-10-30", "正文B完全不一样");
  assert.equal(k1, k2, "正文不应进来源键，否则每周都当新素材");
  assert.ok(k1.includes("2020-10-30"));
});

// ── 分类 ────────────────────────────────────────────────────────────

test("classifyMaterial: 行情/品鉴/知识三类可区分", () => {
  assert.equal(classifyMaterial("大益价格回调500元"), "market");
  assert.equal(classifyMaterial("汤色橙黄明亮，回甘迅速"), "tasting");
  assert.equal(classifyMaterial("杀青揉捻蒸压的工艺流程"), "knowledge");
});

test("MIN_BODY_LENGTH 是有意义的正数（闸门不能形同虚设）", () => {
  assert.ok(MIN_BODY_LENGTH > 0 && MIN_BODY_LENGTH < 5000);
});
