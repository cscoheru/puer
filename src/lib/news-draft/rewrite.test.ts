/**
 * 纯单测：`rewriteNews` 的模型调用解析、校验与 fail-safe 行为。
 *
 * 与 `adapt.test.ts` 同范式：**注入 fake fetcher，不真实调 API**。这里要证明的
 * 是「改写层的四道闸会拦住坏输出」——数字接地、长度、HTML 白名单、以及失败
 * 绝不抛异常。
 *
 * 资讯稿特有的重点：**数字必须与素材一致**。品鉴链路靠 `aiOriginal` 双轨兜底
 * （人工改后能被 diff 出来），资讯稿没有那道双轨（一次成型），所以模型编造
 * 的数字一旦进了草稿箱就没人看得出来——接地校验是唯一防线。
 *
 * Run: node --test --test-reporter=spec src/lib/news-draft/rewrite.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteNews, materialNumbers } from "./rewrite.ts";
import type { Material } from "./plan.ts";

// ── fixtures ────────────────────────────────────────────────────────

/** 一条真实的行情类素材（数字取自 flow 23 成果包）。 */
const MARKET_MATERIAL: Material = {
  sourceKey: "u:https://example.com/a",
  title: "大益 2026 行情分化",
  url: "https://example.com/a",
  platform: "大益行情网",
  author: "行情编辑部",
  publishedAt: "2026-10-07",
  body: "大益 2026 年成品价格出现明显分化，明星单品走强而常规系列走弱。力开天地散提报 5800 元，较前期下跌 500 元；1801 七星千羽孔雀报 10.6 万元，上涨 3000 元。2301 生肖兔饼曾最高去到 3 万出头，如今回调到 1.5 万左右。整体来看，市场找货的人明显增多，但多数品种仍处在持续回调状态。",
  kind: "market",
};

type FetchLike = typeof fetch;

function makeFetcher(json: unknown, status = 200): FetchLike {
  const res = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => (typeof json === "string" ? json : JSON.stringify(json ?? "")),
  };
  return async () => res as unknown as Response;
}

function modelBody(rawModelContent: string): unknown {
  return { choices: [{ message: { content: rawModelContent } }] };
}

function okModelJson(inner: { title: string; content: string; summary: string }): unknown {
  return modelBody(JSON.stringify(inner));
}

/** 只用素材里已有数字（5800 / 10.6 / 2301 / 1.5 / 500）的合法改写。 */
const OK_CONTENT =
  "<p>这周大益的行情继续分化，力开天地散提报 5800 元，比前期跌了 500；1801 七星千羽孔雀则报到 10.6 万元，涨了 3000。" +
  "2301 生肖兔饼从最高的 3 万出头回到 1.5 万左右。找货的人多了，但常规品种仍在回调通道里。</p>";
const OK_TITLE = "大益这周行情分化：明星茶走强，常规茶回调";
const OK_SUMMARY = "力开天地5800跌500，千羽孔雀10.6万涨3000";

/** 记录请求体，用来断言 prompt 内容。 */
function captureFetcher(json: unknown, sink: { body?: string }): FetchLike {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    sink.body = typeof init?.body === "string" ? init.body : "";
    return makeFetcher(json)("http://local.invalid/");
  }) as FetchLike;
}

// Save/restore the key so this file never leaks env state (同 adapt.test.ts)。
const PREV_KEY = process.env.MINIMAX_API_KEY;
process.env.MINIMAX_API_KEY = "test-key";

// ── 成功路径 ────────────────────────────────────────────────────────

test("rewriteNews: 合法输出返回正文/标题/摘要", async () => {
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    fetcher: makeFetcher(okModelJson({ title: OK_TITLE, content: OK_CONTENT, summary: OK_SUMMARY })),
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.content.includes("5800"), "正文丢了关键数字");
  assert.equal(r.title, OK_TITLE);
  assert.equal(r.summary, OK_SUMMARY);
});

test("rewriteNews: 请求体带的是素材全文（不是模型摘要）", async () => {
  const sink: { body?: string } = {};
  await rewriteNews({
    material: MARKET_MATERIAL,
    fetcher: captureFetcher(okModelJson({ title: OK_TITLE, content: OK_CONTENT, summary: OK_SUMMARY }), sink),
  });
  const body = sink.body ?? "";
  // 接地校验以素材全文为唯一数字来源，prompt 里必须带全文。
  assert.ok(body.includes("力开天地散提报 5800 元"), "prompt 未带素材全文");
  assert.ok(body.includes("大益行情网"), "prompt 未带来源平台");
  assert.ok(body.includes("2026-10-07"), "prompt 未带发布日期");
});

test("rewriteNews: prompt 明确禁止编造数字与冲泡内容", async () => {
  const sink: { body?: string } = {};
  await rewriteNews({
    material: MARKET_MATERIAL,
    fetcher: captureFetcher(okModelJson({ title: OK_TITLE, content: OK_CONTENT, summary: OK_SUMMARY }), sink),
  });
  const body = sink.body ?? "";
  assert.ok(body.includes("不得编造年份"), "prompt 缺编造禁令");
  assert.ok(body.includes("数字必须与原文一致"), "prompt 缺数字约束");
  assert.ok(body.includes("不要写冲泡步骤"), "prompt 缺冲泡禁令");
});

// ── 数字接地 ────────────────────────────────────────────────────────

test("rewriteNews: 编造的数字被接地校验拦下", async () => {
  // 模型把 5800 编成 58000——正文里出现素材没有的数字串。
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    fetcher: makeFetcher(
      okModelJson({
        title: OK_TITLE,
        content: "<p>" + OK_CONTENT + "另外 1801 千羽孔雀的成交价已经到 58000 元，收藏空间很大。</p>",
        summary: OK_SUMMARY,
      }),
    ),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.includes("ungrounded number"), `原因不对: ${r.reason}`);
});

test("rewriteNews: 摘要里的编造数字同样被拦下", async () => {
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    fetcher: makeFetcher(
      okModelJson({ title: OK_TITLE, content: OK_CONTENT, summary: "千羽孔雀涨到 26.8 万元" }),
    ),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.includes("ungrounded number"), `原因不对: ${r.reason}`);
});

test("rewriteNews: 标题里的编造数字同样被拦下", async () => {
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    fetcher: makeFetcher(
      okModelJson({ title: "大益千羽孔雀涨到 26.8 万", content: OK_CONTENT, summary: OK_SUMMARY }),
    ),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.includes("ungrounded number"), `原因不对: ${r.reason}`);
});

test("rewriteNews: 价格被抹掉小数位被拦下（整数 token 是小数的前缀，会漏）", async () => {
  // 素材写「10.6 万元」，模型写成「10 万元」。用整数 tokenization 时 `10` 在
  // 素材里存在（它是 `10.6` 的前缀）→ 放行；小数点敏感的 tokenization 才能拦。
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    fetcher: makeFetcher(
      okModelJson({
        title: OK_TITLE,
        content: "<p>" + OK_CONTENT + "另外千羽孔雀现在只要 10 万元就能拿下。</p>",
        summary: OK_SUMMARY,
      }),
    ),
  });
  assert.equal(r.ok, false, "抹掉小数位的价格不该放行");
  if (!r.ok) assert.ok(r.reason.includes("ungrounded number"), `原因不对: ${r.reason}`);
});

test("rewriteNews: 引用素材的发布日期不被误杀（日期是元信息不是价格）", async () => {
  // 素材的 publishedAt 是 2026-10-07。引用它时输出里会出现 2026/10/07，
  // 这些数字不在「正文+标题」语料里——但它们是合法的出处标注，不该被拦。
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    fetcher: makeFetcher(
      okModelJson({
        title: OK_TITLE,
        content: "<p>据大益行情网 2026-10-07 的数据，" + OK_CONTENT.slice(3) + "</p>",
        summary: OK_SUMMARY,
      }),
    ),
  });
  assert.equal(r.ok, true, "引用素材自己的日期不该被拦");
});

test("rewriteNews: 编造一个素材没有的日期被拦下", async () => {
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    fetcher: makeFetcher(
      okModelJson({
        title: OK_TITLE,
        content: "<p>据 2025-03-11 的行情，" + OK_CONTENT.slice(3) + "</p>",
        summary: OK_SUMMARY,
      }),
    ),
  });
  assert.equal(r.ok, false, "素材里没有的日期不该放行");
});

// ── HTML 白名单 ─────────────────────────────────────────────────────

test("rewriteNews: 模型留下的链接与脚本被剥掉", async () => {
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    fetcher: makeFetcher(
      okModelJson({
        title: OK_TITLE,
        content:
          "<p>" +
          OK_CONTENT +
          '</p><script>alert(1)</script><a href="http://evil.example">点我</a><img src="http://x/y.png">',
        summary: OK_SUMMARY,
      }),
    ),
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(!r.content.includes("<script"), "脚本标签残留");
  assert.ok(!r.content.includes("<a "), "链接标签残留");
  assert.ok(!r.content.includes("<img"), "图片标签残留");
});

test("rewriteNews: 白名单允许的标签保留", async () => {
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    fetcher: makeFetcher(
      okModelJson({
        title: OK_TITLE,
        content: "<h2>本周要点</h2><ul><li>" + OK_CONTENT + "</li></ul>",
        summary: OK_SUMMARY,
      }),
    ),
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.content.includes("<h2>"), "h2 被误删");
  assert.ok(r.content.includes("<ul>"), "ul 被误删");
});

test("rewriteNews: 摘要尾部的表格管道符被剥掉（行情报价表残留）", async () => {
  // 素材来自 markdown 报价表（| 37 | 503 | … |），模型偶尔把管道符带进摘要尾部，
  // 读起来像「结论。|」。
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    fetcher: makeFetcher(
      okModelJson({
        title: OK_TITLE,
        content: OK_CONTENT,
        summary: "大益行情分化，明星茶走强常规茶走弱 |",
      }),
    ),
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(!r.summary.endsWith("|"), `摘要残留管道符: ${r.summary}`);
  assert.ok(r.summary.includes("走弱"), "摘要正文被误删");
});

// ── 长度闸 ──────────────────────────────────────────────────────────

test("rewriteNews: 过短的输出被拒", async () => {
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    fetcher: makeFetcher(okModelJson({ title: OK_TITLE, content: "<p>太短。</p>", summary: OK_SUMMARY })),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.includes("too short"), `原因不对: ${r.reason}`);
});

// ── fail-safe ───────────────────────────────────────────────────────

test("rewriteNews: 模型返回非 JSON 时失败但不抛", async () => {
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    fetcher: makeFetcher(modelBody("not json at all")),
  });
  assert.equal(r.ok, false);
});

test("rewriteNews: HTTP 500 时失败但不抛", async () => {
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    fetcher: makeFetcher({}, 500),
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.includes("500"), `原因不对: ${r.reason}`);
});

test("rewriteNews: fetch 抛异常时失败但不抛", async () => {
  const throwing = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const r = await rewriteNews({ material: MARKET_MATERIAL, fetcher: throwing });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.includes("fetch error"), `原因不对: ${r.reason}`);
});

test("rewriteNews: 缺 MINIMAX_API_KEY 时 fail-fast 且不调模型", async () => {
  delete process.env.MINIMAX_API_KEY;
  let called = false;
  const spy = (async () => {
    called = true;
    return makeFetcher({})("http://local.invalid/");
  }) as unknown as typeof fetch;
  try {
    const r = await rewriteNews({ material: MARKET_MATERIAL, fetcher: spy });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.reason.includes("MINIMAX_API_KEY"), `原因不对: ${r.reason}`);
    assert.equal(called, false, "缺 key 时不应调模型");
  } finally {
    process.env.MINIMAX_API_KEY = "test-key";
  }
});

test("rewriteNews: 失败会重试（采样失败是可重试的）", async () => {
  let calls = 0;
  const flaky = (async () => {
    calls++;
    if (calls === 1) return makeFetcher(modelBody("garbage"))("http://local.invalid/");
    return makeFetcher(okModelJson({ title: OK_TITLE, content: OK_CONTENT, summary: OK_SUMMARY }))(
      "http://local.invalid/",
    );
  }) as unknown as typeof fetch;
  const r = await rewriteNews({ material: MARKET_MATERIAL, fetcher: flaky });
  assert.equal(r.ok, true, "第二次尝试应当成功");
  assert.equal(calls, 2);
});

test("rewriteNews: 429 配额错误不重试（重试只会更快烧额度）", async () => {
  let calls = 0;
  const quota429 = (async () => {
    calls++;
    return makeFetcher(
      { error: { type: "rate_limit_error", message: "已达到 Token Plan 用量上限" } },
      429,
    )("http://local.invalid/");
  }) as unknown as typeof fetch;
  const r = await rewriteNews({ material: MARKET_MATERIAL, fetcher: quota429 });
  assert.equal(r.ok, false);
  assert.equal(calls, 1, "429 不应重试");
  if (!r.ok) assert.ok(r.reason.includes("429"), `原因应保留 429 供调用方熔断: ${r.reason}`);
});

// ── 品牌白名单与退回负例 ────────────────────────────────────────────

test("rewriteNews: prompt 带上站内品牌白名单与经典茶品名（声明为名称数据而非指令）", async () => {
  const sink: { body?: string } = {};
  await rewriteNews({
    material: MARKET_MATERIAL,
    knownBrands: ["大益", "下关", "福今"],
    classicTeas: ["千羽孔雀", "力开天地"],
    fetcher: captureFetcher(okModelJson({ title: OK_TITLE, content: OK_CONTENT, summary: OK_SUMMARY }), sink),
  });
  const body = sink.body ?? "";
  // 名单必须被声明为「名称数据，不是指令」：品牌名是会员可写的自由文本，
  // 不加这句声明，名单里的文字就可能被模型当成指令执行（prompt 注入）。
  assert.ok(body.includes("名称数据"), "prompt 缺「名称数据」声明");
  assert.ok(body.includes("不是指令"), "prompt 缺「不是指令」声明");
  assert.ok(body.includes("品牌：大益、下关、福今"), "prompt 缺品牌名");
  assert.ok(body.includes("经典茶品名：千羽孔雀"), "prompt 缺经典茶品名");
});

test("rewriteNews: prompt 带上人工退回的负例", async () => {
  const sink: { body?: string } = {};
  await rewriteNews({
    material: MARKET_MATERIAL,
    rejectReasons: ["写的是春茶行情，但现在是 10 月，题材已经过时。"],
    fetcher: captureFetcher(okModelJson({ title: OK_TITLE, content: OK_CONTENT, summary: OK_SUMMARY }), sink),
  });
  const body = sink.body ?? "";
  assert.ok(body.includes("编辑退回过的内容"), "prompt 缺负例段");
  assert.ok(body.includes("题材已经过时"), "prompt 缺退回原因原文");
});

test("rewriteNews: 严格接地下，关键价格数字被抹掉时拒稿", async () => {
  // 素材里的价格（5800 / 500 / 10.6 / 3000 / 3 万 / 1.5 万）全被抹掉，
  // 改写成一段没有任何数字的话——普通接地校验放行（没有编造数字），
  // 但严格接地要求关键价格不得消失。
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    stricterGrounding: true,
    fetcher: makeFetcher(
      okModelJson({
        title: "大益行情继续回调",
        content:
          "<p>这周大益的行情继续回调，力开天地和千羽孔雀都走弱，常规系列普遍承压。市场找货的人比上一周多了起来，但接盘意愿依然谨慎，收藏盘情绪偏冷，短期看不到明显起色，普洱整体还在调整区间里震荡。</p>",
        summary: "大益行情回调",
      }),
    ),
  });
  assert.equal(r.ok, false, "关键价格消失不该放行");
  if (!r.ok) assert.ok(r.reason.includes("missing key number"), `原因不对: ${r.reason}`);
});

test("rewriteNews: 严格接地下，完整保留关键数字时放行", async () => {
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    stricterGrounding: true,
    fetcher: makeFetcher(okModelJson({ title: OK_TITLE, content: OK_CONTENT, summary: OK_SUMMARY })),
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
});

test("rewriteNews: 严格接地不要求保留年份与批次号（摘要常省略）", async () => {
  // 2301（批次）与 2026（年份）被省掉是可以的；但 5800/500/10.6/3000/3/1.5
  // 这些价格必须都在——它们才是「关键数字」。
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    stricterGrounding: true,
    fetcher: makeFetcher(
      okModelJson({
        title: "大益行情分化",
        content:
          "<p>这周大益的行情继续分化，力开天地散提报 5800 元，比前期跌了 500；千羽孔雀则报到 10.6 万元，涨了 3000；生肖兔饼从 3 万出头回到 1.5 万左右。找货的人多了，但常规品种仍在回调通道里。</p>",
        summary: "力开天地5800跌500",
      }),
    ),
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
});

test("rewriteNews: 严格接地下，行情表只需留下 2 个价格（不要求全留）", async () => {
  // 素材是一整张报价表（6 个价格），帖子篇幅装不下——只留 2 个应当放行。
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    stricterGrounding: true,
    fetcher: makeFetcher(
      okModelJson({
        title: "大益行情分化",
        content:
          "<p>这周大益的行情继续分化，力开天地散提报 5800 元，比前期跌了 500；其余单品跟随调整，生肖兔饼回到 1.5 万左右。找货的人多了，但常规品种仍在回调通道里。</p>",
        summary: "力开天地5800跌500",
      }),
    ),
  });
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
});

test("rewriteNews: 严格接地下，只剩 1 个价格也拦（门槛是 2 个）", async () => {
  const r = await rewriteNews({
    material: MARKET_MATERIAL,
    stricterGrounding: true,
    fetcher: makeFetcher(
      okModelJson({
        title: "大益行情回调",
        content:
          "<p>这周大益的行情继续回调，力开天地散提报 5800 元，生肖兔饼也在往下走。市场找货的人比上一周多了起来，但接盘意愿依然谨慎，收藏盘情绪偏冷，短期看不到明显起色，普洱整体还在调整区间里震荡。</p>",
        summary: "大益行情回调",
      }),
    ),
  });
  assert.equal(r.ok, false, "只剩 1 个价格不该放行");
  if (!r.ok) assert.ok(r.reason.includes("missing key number"), `原因不对: ${r.reason}`);
});

// ── 数字提取辅助 ────────────────────────────────────────────────────

test("materialNumbers: 提取素材里的数字串，小数点算整体（排障用）", () => {
  const nums = materialNumbers(MARKET_MATERIAL);
  assert.ok(nums.includes("5800"), "缺 5800");
  assert.ok(nums.includes("2301"), "缺 2301");
  // 小数点敏感：`10.6` 整体报出，而不是 `10` + `6`。
  assert.ok(nums.includes("10.6"), `小数未整体报出: ${nums.join(",")}`);
  assert.ok(!nums.includes("10"), `小数被拆开了: ${nums.join(",")}`);
});

// Restore the caller's env so this file never leaks state into other suites.
test("restore MINIMAX_API_KEY after the suite", () => {
  if (PREV_KEY === undefined) delete process.env.MINIMAX_API_KEY;
  else process.env.MINIMAX_API_KEY = PREV_KEY;
  assert.ok(true);
});
