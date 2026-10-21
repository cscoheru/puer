/**
 * 纯单测：`feedback-policy` 的退回分类校验、反馈→规则推导、时效/跨季判定、
 * 品牌与具象信号打分。
 *
 * Run: node --test --test-reporter=spec src/lib/news-draft/feedback-policy.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FEEDBACK_POLICY,
  FEEDBACK_CATEGORIES,
  MIN_FEEDBACK_SAMPLES,
  deriveFeedbackPolicy,
  evaluateMaterial,
  extractDates,
  latestMaterialDate,
  countConcreteSignals,
  isCrossSeasonMaterial,
  normalizeFeedbackReason,
  parseFeedbackCategory,
  scoreBrands,
  type FeedbackEntry,
} from "./feedback-policy.ts";

// ── fixtures ────────────────────────────────────────────────────────

/** 2026-10-21 12:00:00 UTC（十月中旬，用于跨季判定）。 */
const OCT_2026 = Date.UTC(2026, 9, 21, 12);

const BRANDS = [
  { brand: "大益", count: 357, classicCount: 12 },
  { brand: "下关", count: 64, classicCount: 3 },
  { brand: "福今", count: 46, classicCount: 1 },
  { brand: "昌泰", count: 45, classicCount: 0 },
];

/** 一条当期行情稿（2026-10 的价格、品牌、产区、批次齐全）。 */
const FRESH_MARKET = {
  title: "大益 2601 行情速览",
  publishedAt: "2026-10-07",
  body:
    "大益 2601 批次千羽孔雀散提报 9800 元，较上周下跌 300 元；福今 布朗王熟饼报 2200 元。冰岛产区春料毛茶收购价维持在 65 元一公斤，市场找货的人增多。",
};

/** 一条「10 月还在讲春茶」的过时素材。 */
const STALE_SPRING = {
  title: "2026 年春茶价格行情汇总",
  publishedAt: "",
  body:
    "本文汇总 2026 年各产区春茶价格：冰岛古树春料 1200 元一公斤，班章春毛茶 800 元，勐库春尖 350 元。整体来看春茶品质优于去年。",
};

/** 一条 2020 年的老素材。 */
const OLD_2020 = {
  title: "大益 2001 批千羽孔雀行情",
  publishedAt: "2020-10-30",
  body: "大益 2001 批次千羽孔雀整提报价 12 万元，班章料春茶市价 600 元一公斤，市场热度一般。",
};

/** 一条没有日期、也没有品牌/产区/数字的空洞稿。 */
const VAGUE = {
  title: "普洱茶市场观察",
  publishedAt: "",
  body: "近期普洱茶市场整体表现平稳，优质原料的收藏价值逐渐凸显，茶友们的品鉴热情有所回升，行业前景依旧可观。",
};

// ── 分类与原因校验 ──────────────────────────────────────────────────

test("parseFeedbackCategory: 五个合法分类都认", () => {
  for (const c of FEEDBACK_CATEGORIES) {
    assert.equal(parseFeedbackCategory(c), c);
  }
});

test("parseFeedbackCategory: 非法值返回 null（不静默归一化）", () => {
  assert.equal(parseFeedbackCategory("stale-ish"), null);
  assert.equal(parseFeedbackCategory("STALE"), null);
  assert.equal(parseFeedbackCategory(""), null);
  assert.equal(parseFeedbackCategory(undefined), null);
  assert.equal(parseFeedbackCategory(42), null);
});

test("normalizeFeedbackReason: 过短/超长/非串都拒绝", () => {
  assert.equal(normalizeFeedbackReason("不好"), null);
  assert.equal(normalizeFeedbackReason("  "), null);
  assert.equal(normalizeFeedbackReason(null), null);
  assert.equal(normalizeFeedbackReason("x".repeat(501)), null);
});

test("normalizeFeedbackReason: 合规原因 trim 后返回", () => {
  assert.equal(normalizeFeedbackReason("  讲的是春茶，现在已经十月了  "), "讲的是春茶，现在已经十月了");
});

// ── 反馈 → 规则推导 ─────────────────────────────────────────────────

test("deriveFeedbackPolicy: 样本不足时不动规则（一条反馈不能关死管线）", () => {
  const entries: FeedbackEntry[] = Array.from({ length: MIN_FEEDBACK_SAMPLES - 1 }, () => ({
    category: "stale",
    reason: "过时了",
    at: new Date(OCT_2026).toISOString(),
  }));
  const p = deriveFeedbackPolicy(entries, OCT_2026);
  assert.equal(p.maxAgeDays, DEFAULT_FEEDBACK_POLICY.maxAgeDays);
  assert.equal(p.samples, MIN_FEEDBACK_SAMPLES - 1);
});

test("deriveFeedbackPolicy: stale 占比达标则收紧时效闸", () => {
  const entries: FeedbackEntry[] = [
    ...Array.from({ length: 3 }, () => ({ category: "stale" as const, reason: "春茶稿" })),
    ...Array.from({ length: 2 }, () => ({ category: "other" as const, reason: "别的" })),
  ].map((e) => ({ ...e, at: new Date(OCT_2026).toISOString() }));
  const p = deriveFeedbackPolicy(entries, OCT_2026);
  assert.equal(p.maxAgeDays, 60);
  assert.equal(p.rejectCrossSeason, true);
});

test("deriveFeedbackPolicy: unknown_brand 占比达标则要求命中已知品牌", () => {
  const entries: FeedbackEntry[] = [
    ...Array.from({ length: 3 }, () => ({ category: "unknown_brand" as const, reason: "杂牌" })),
    ...Array.from({ length: 2 }, () => ({ category: "other" as const, reason: "别的" })),
  ].map((e) => ({ ...e, at: new Date(OCT_2026).toISOString() }));
  const p = deriveFeedbackPolicy(entries, OCT_2026);
  assert.equal(p.requireKnownBrand, true);
});

test("deriveFeedbackPolicy: vague 占比达标则提高具象信号门槛", () => {
  const entries: FeedbackEntry[] = [
    ...Array.from({ length: 3 }, () => ({ category: "vague" as const, reason: "太泛" })),
    ...Array.from({ length: 2 }, () => ({ category: "other" as const, reason: "别的" })),
  ].map((e) => ({ ...e, at: new Date(OCT_2026).toISOString() }));
  const p = deriveFeedbackPolicy(entries, OCT_2026);
  assert.equal(p.minConcreteSignals, 2);
});

test("deriveFeedbackPolicy: inaccurate 占比达标则收紧接地", () => {
  const entries: FeedbackEntry[] = [
    ...Array.from({ length: 3 }, () => ({ category: "inaccurate" as const, reason: "数字不对" })),
    ...Array.from({ length: 2 }, () => ({ category: "other" as const, reason: "别的" })),
  ].map((e) => ({ ...e, at: new Date(OCT_2026).toISOString() }));
  assert.equal(deriveFeedbackPolicy(entries, OCT_2026).stricterGrounding, true);
});

test("deriveFeedbackPolicy: 窗口外的反馈不参与统计", () => {
  const old = new Date(OCT_2026 - 60 * 86_400_000).toISOString();
  const entries: FeedbackEntry[] = Array.from({ length: 10 }, () => ({
    category: "stale" as const,
    reason: "很久以前",
    at: old,
  }));
  const p = deriveFeedbackPolicy(entries, OCT_2026);
  assert.equal(p.samples, 0);
  assert.equal(p.maxAgeDays, DEFAULT_FEEDBACK_POLICY.maxAgeDays);
});

// ── 日期抽取 ────────────────────────────────────────────────────────

test("extractDates: 三种中文/数字日期形态都能抽到", () => {
  const ds = extractDates("2026年9月27日 的报道，以及 2026-10-07 和 2026/09/27 两处");
  assert.ok(ds.length >= 3, `只抽到 ${ds.length} 个`);
  assert.ok(ds.every((d) => d.getUTCFullYear() === 2026));
});

test("extractDates: 批次号 2601 不被当成日期", () => {
  const ds = extractDates("大益 2601 批次千羽孔雀，2405 批次生茶");
  assert.equal(ds.length, 0, `批次号被误判为日期: ${ds.map(String).join(",")}`);
});

test("extractDates: 非法日期（2 月 31 日）被丢弃而非 rollover", () => {
  const ds = extractDates("2026-02-31 的记录");
  assert.equal(ds.length, 0);
});

test("extractDates: 年月形态（无日）落到当月 1 号", () => {
  const ds = extractDates("2026年9月的行情");
  assert.equal(ds.length, 1);
  assert.equal(ds[0].getUTCMonth(), 8);
  assert.equal(ds[0].getUTCDate(), 1);
});

test("latestMaterialDate: 取正文与 publishedAt 的较新者", () => {
  const d = latestMaterialDate(
    { publishedAt: "2020-10-30", body: "2026 年 10 月 7 日的报价", title: "" },
    OCT_2026,
  );
  assert.ok(d);
  assert.equal(d.getUTCFullYear(), 2026);
});

test("latestMaterialDate: 未来日期（预售口径）被忽略", () => {
  const d = latestMaterialDate({ publishedAt: "", body: "2027 年预售会 3 万元" }, OCT_2026);
  assert.equal(d, null);
});

test("latestMaterialDate: 没有任何日期时返回 null", () => {
  assert.equal(latestMaterialDate({ publishedAt: "", body: "没有日期的稿子" }, OCT_2026), null);
});

// ── 跨季春茶 ────────────────────────────────────────────────────────

test("isCrossSeasonMaterial: 10 月讲春茶且无近期日期 → 过季", () => {
  assert.equal(isCrossSeasonMaterial(STALE_SPRING, OCT_2026), true);
});

test("isCrossSeasonMaterial: 春茶季（3 月）不拦", () => {
  const march = Date.UTC(2026, 2, 21, 12);
  assert.equal(isCrossSeasonMaterial(STALE_SPRING, march), false);
});

test("isCrossSeasonMaterial: 正文带近期日期时不拦（当期稿顺带提春茶）", () => {
  const mat = {
    title: "大益 2601 行情与春茶话题",
    publishedAt: "2026-10-07",
    body: "大益 2601 千羽孔雀报 9800 元。春茶话题仍被老茶友提起，但本期只聊当期批次。",
  };
  assert.equal(isCrossSeasonMaterial(mat, OCT_2026), false);
});

test("isCrossSeasonMaterial: 不含春茶词的内容不受影响", () => {
  assert.equal(isCrossSeasonMaterial(FRESH_MARKET, OCT_2026), false);
});

// ── 品牌与具象信号 ──────────────────────────────────────────────────

test("scoreBrands: 命中已知品牌并按库中存量加权", () => {
  const s = scoreBrands("大益与福今的行情对比", BRANDS);
  assert.deepEqual(s.matched, ["大益", "福今"]);
  assert.equal(s.top, "大益");
  assert.ok(s.score > 0);
});

test("scoreBrands: 未提及任何已知品牌时得分为 0", () => {
  const s = scoreBrands("某不知名小厂的茶", BRANDS);
  assert.equal(s.matched.length, 0);
  assert.equal(s.score, 0);
  assert.equal(s.top, null);
});

test("scoreBrands: 有经典存量的品牌获得加成", () => {
  const s = scoreBrands("大益", BRANDS);
  assert.ok(s.classicHits.includes("大益"));
});

test("countConcreteSignals: 四类信号分别计数", () => {
  // 价格 + 品牌 + 产区 + 批次
  assert.equal(countConcreteSignals(FRESH_MARKET.body, BRANDS), 4);
  // 只有泛泛而谈
  assert.equal(countConcreteSignals(VAGUE.body, BRANDS), 0);
});

// ── 素材评估 ────────────────────────────────────────────────────────

test("evaluateMaterial: 当期行情稿通过", () => {
  const r = evaluateMaterial(FRESH_MARKET, {
    now: OCT_2026,
    policy: DEFAULT_FEEDBACK_POLICY,
    brands: BRANDS,
    classicTeas: ["千羽孔雀"],
  });
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.score > 0);
  assert.ok(r.brands.includes("大益"));
  assert.ok(r.classicTeas.includes("千羽孔雀"));
});

test("evaluateMaterial: 2020 年的老素材被时效闸拦下", () => {
  const r = evaluateMaterial(OLD_2020, {
    now: OCT_2026,
    policy: DEFAULT_FEEDBACK_POLICY,
    brands: BRANDS,
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason?.includes("素材过时"), r.reason);
});

test("evaluateMaterial: 10 月的春茶稿被跨季闸拦下", () => {
  const r = evaluateMaterial(STALE_SPRING, {
    now: OCT_2026,
    policy: DEFAULT_FEEDBACK_POLICY,
    brands: BRANDS,
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason?.includes("过季春茶"), r.reason);
});

test("evaluateMaterial: 反馈要求命中已知品牌时，无品牌素材被拦", () => {
  const noBrand = {
    title: "某山头小厂 2026 批次行情",
    publishedAt: "2026-10-05",
    body: "某山头小厂 2026 批次报价 1200 元一提，冰岛产区料，市场走量一般。",
  };
  const policy = { ...DEFAULT_FEEDBACK_POLICY, requireKnownBrand: true };
  const r = evaluateMaterial(noBrand, { now: OCT_2026, policy, brands: BRANDS });
  assert.equal(r.ok, false);
  assert.ok(r.reason?.includes("已知品牌"), r.reason);
});

test("evaluateMaterial: 要求两类具象信号时，空洞稿被拦", () => {
  const policy = { ...DEFAULT_FEEDBACK_POLICY, minConcreteSignals: 2 };
  const r = evaluateMaterial(VAGUE, { now: OCT_2026, policy, brands: BRANDS });
  assert.equal(r.ok, false);
  assert.ok(r.reason?.includes("笼统"), r.reason);
});

test("evaluateMaterial: 知名品牌的稿排序分高于杂牌稿", () => {
  const ctx = {
    now: OCT_2026,
    policy: DEFAULT_FEEDBACK_POLICY,
    brands: BRANDS,
  };
  const known = evaluateMaterial(FRESH_MARKET, ctx);
  const unknown = evaluateMaterial(
    {
      title: "小厂 2601 行情",
      publishedAt: "2026-10-06",
      body: "小厂 2601 批次报价 1500 元一提，普洱产区料，市场平稳。",
    },
    ctx,
  );
  assert.ok(known.ok && unknown.ok);
  assert.ok(known.score > unknown.score, `知名 ${known.score} 未高于杂牌 ${unknown.score}`);
});
