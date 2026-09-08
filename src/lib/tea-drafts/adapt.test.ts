/**
 * Tests for adapt.ts (Phase D grounded LLM adaptation).
 *
 * Covers the pure safety gates (numeric grounding, length bounds, source
 * derivation) with no network, and exercises deepSeekAdapt with an injected
 * fake fetcher so model-call parsing, validation, and fail-safe behavior are
 * tested without hitting the network.
 *
 * Run: node --test --test-reporter=spec src/lib/tea-drafts/adapt.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toAdaptSource,
  extractNumberTokens,
  isGrounded,
  checkAdaptLength,
  deepSeekAdapt,
} from "./adapt.ts";
import type { NormalizedNote } from "./normalize.ts";

// ─── fixtures ───────────────────────────────────────────────────────────

const SENTENCE = "外观汤色金黄,香气沉稳,入口顺滑饱满,回甘持久,耐泡度不错,尾水略有涩感。";

function nn(over: Partial<NormalizedNote> = {}): NormalizedNote {
  return {
    id: "cjld2cjxh0000qzrmn831i7rn",
    title: "某山头古树春茶",
    content: "<p>" + SENTENCE.repeat(6) + "</p>",
    summary: null,
    teaId: "tea-1",
    authorId: "auth-1",
    source: "manual",
    brewMethod: null,
    waterTemp: null,
    teaWeight: null,
    steepCount: null,
    images: null,
    videoUrl: null,
    createdAt: 1000,
    ...over,
  };
}

// A model body that reuses only source-present numbers (100 from waterTemp,
// 7 from steepCount). Long enough to clear the length gate vs the fixture.
const OK_BODY_HTML =
  "<p>这款古树春茶汤色金黄透亮,香气沉稳内敛,入口顺滑饱满,回甘持久且层次分明,耐泡度相当不错;" +
  "不足之处是尾水略带涩感、且前两泡厚度稍欠。冲泡上用100度热水、投茶7克,过程从简,重点记录口感。</p>";
const OK_SUMMARY = "回甘持久,尾水略涩";

// Inject a fetcher returning a DeepSeek-shaped body. `content` is the raw
// model string placed at choices[0].message.content (already JSON-stringified
// by the model into {content,summary}).
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

function dsBody(rawModelContent: string): unknown {
  return { choices: [{ message: { content: rawModelContent } }] };
}

function okModelJson(inner: { content: string; summary: string }): unknown {
  return dsBody(JSON.stringify(inner));
}

// Save/restore the key so this file never leaks env state.
const PREV_KEY = process.env.DEEPSEEK_API_KEY;
process.env.DEEPSEEK_API_KEY = "test-key";

// ─── extractNumberTokens ────────────────────────────────────────────────

test("extractNumberTokens: captures maximal arabic-digit runs", () => {
  assert.deepEqual(extractNumberTokens("2024年95分7克100度"), ["2024", "95", "7", "100"]);
  assert.deepEqual(extractNumberTokens("v1.2.3"), ["1", "2", "3"]);
});

test("extractNumberTokens: Chinese numerals are NOT matched (intentional)", () => {
  assert.deepEqual(extractNumberTokens("七克十秒百元"), []);
  assert.deepEqual(extractNumberTokens(""), []);
});

// ─── isGrounded ─────────────────────────────────────────────────────────

test("isGrounded: source-present numbers pass", () => {
  const corpus = "水温:100℃ 投茶量:7克 年份:2024";
  assert.equal(isGrounded("水温100度,投茶7克,2024年产", corpus).ok, true);
});

test("isGrounded: an invented score/year is rejected", () => {
  const corpus = "汤色金黄,回甘持久。水温:100℃";
  const r = isGrounded("这款茶我给95分", corpus);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /95/);
});

test("isGrounded: no digits in adapted text → trivially grounded", () => {
  assert.equal(isGrounded("七克十秒,回甘不错", "").ok, true);
});

// ─── checkAdaptLength ───────────────────────────────────────────────────

test("checkAdaptLength: within [0.3x, 1.5x] and ≥60 → ok", () => {
  assert.equal(checkAdaptLength(100, 100).ok, true); // 1.0x
  assert.equal(checkAdaptLength(60, 200).ok, true); // 0.3x exactly
  assert.equal(checkAdaptLength(150, 100).ok, true); // 1.5x exactly
});

test("checkAdaptLength: below 60cp absolute minimum → rejected", () => {
  const r = checkAdaptLength(40, 100);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /too short/);
});

test("checkAdaptLength: above hard ceiling → rejected", () => {
  const r = checkAdaptLength(3000, 1000);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /too long/);
});

test("checkAdaptLength: ratio below 0.3x → rejected (trims too aggressively)", () => {
  // 70cp clears the absolute min(60) but 70/300 = 0.23x < 0.3x floor → rejected.
  const r = checkAdaptLength(70, 300);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /0\.23x < 0\.3x/);
});

test("checkAdaptLength: ratio above 1.5x → rejected (rambling)", () => {
  const r = checkAdaptLength(200, 100); // 2.0x
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /> 1\.5x/);
});

test("checkAdaptLength: zero-length source → only absolute min/max apply", () => {
  assert.equal(checkAdaptLength(100, 0).ok, true);
});

// ─── toAdaptSource ──────────────────────────────────────────────────────

test("toAdaptSource: corpus carries title + plain body + rendered brew facts", () => {
  const src = toAdaptSource(
    nn({
      title: "金大益2024",
      content: "<p>汤色金黄,<b>七水</b>仍有甜。</p>",
      brewMethod: "盖碗",
      waterTemp: 100,
      teaWeight: "7克",
      steepCount: 7,
    }),
  );
  assert.equal(src.title, "金大益2024");
  // HTML stripped out of plainText.
  assert.ok(src.plainText.includes("汤色金黄"));
  assert.ok(src.plainText.includes("七水仍有甜"));
  assert.ok(!src.plainText.includes("<"));
  // Corpus aggregates title + body + brew line.
  assert.ok(src.corpus.includes("金大益2024"));
  assert.ok(src.corpus.includes("盖碗"));
  assert.ok(src.corpus.includes("水温:100℃"));
  assert.ok(src.corpus.includes("投茶量:7克"));
  assert.ok(src.corpus.includes("耐泡度:7泡"));
  // Brew-derived numbers count as grounded facts.
  assert.ok(extractNumberTokens(src.corpus).includes("2024"));
  assert.ok(extractNumberTokens(src.corpus).includes("100"));
  assert.ok(extractNumberTokens(src.corpus).includes("7"));
});

// ─── deepSeekAdapt (fake fetcher) ───────────────────────────────────────

test("deepSeekAdapt: well-formed grounded response → ok with sanitized content", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  const r = await deepSeekAdapt({
    source,
    fetcher: makeFetcher(okModelJson({ content: OK_BODY_HTML, summary: OK_SUMMARY })),
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.content.startsWith("<p>"));
    assert.ok(r.content.length > 0);
    assert.equal(r.summary, OK_SUMMARY);
  }
});

test("deepSeekAdapt: strips a <script> injected by the model, keeps the safe body", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  const r = await deepSeekAdapt({
    source,
    fetcher: makeFetcher(
      okModelJson({ content: OK_BODY_HTML + "<script>alert(1)</script>", summary: OK_SUMMARY }),
    ),
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(!r.content.toLowerCase().includes("script"));
  }
});

test("deepSeekAdapt: a fabricated number in the body → rejected (grounding)", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 })); // no 2024 in source
  const body2024 =
    "<p>这款2024年的古树春茶汤色金黄透亮,香气沉稳,入口顺滑饱满,回甘持久,耐泡度不错;" +
    "不足是尾水略带涩感。冲泡用100度热水、投茶7克,整体表现稳定。</p>";
  const r = await deepSeekAdapt({
    source,
    fetcher: makeFetcher(okModelJson({ content: body2024, summary: "回甘不错" })),
  });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /ungrounded number: 2024/);
});

test("deepSeekAdapt: a fabricated number in the SUMMARY → rejected (body+summary grounding)", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 })); // no 95 in source
  const r = await deepSeekAdapt({
    source,
    fetcher: makeFetcher(okModelJson({ content: OK_BODY_HTML, summary: "我给95分" })),
  });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /ungrounded number: 95/);
});

test("deepSeekAdapt: too-short body → rejected", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  const r = await deepSeekAdapt({
    source,
    fetcher: makeFetcher(okModelJson({ content: "<p>短。</p>", summary: "还行" })),
  });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /too short/);
});

test("deepSeekAdapt: non-JSON model content → rejected", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  const r = await deepSeekAdapt({
    source,
    fetcher: makeFetcher(dsBody("not json at all")),
  });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /no JSON object/);
});

test("deepSeekAdapt: empty content → rejected", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  const r = await deepSeekAdapt({
    source,
    fetcher: makeFetcher(okModelJson({ content: "   ", summary: "x" })),
  });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /empty content or summary/);
});

test("deepSeekAdapt: HTTP non-ok → rejected with status", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  const r = await deepSeekAdapt({ source, fetcher: makeFetcher({}, 500) });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /DeepSeek 500/);
});

test("deepSeekAdapt: fetch throws → rejected, never throws", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  const throwing = (async () => {
    throw new Error("boom");
  }) as FetchLike;
  const r = await deepSeekAdapt({ source, fetcher: throwing });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /fetch error: boom/);
});

test("deepSeekAdapt: missing API key → rejected (fail-closed)", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const r = await deepSeekAdapt({
      source,
      fetcher: makeFetcher(okModelJson({ content: OK_BODY_HTML, summary: OK_SUMMARY })),
    });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /DEEPSEEK_API_KEY missing/);
  } finally {
    process.env.DEEPSEEK_API_KEY = "test-key";
  }
});

// Restore whatever was there before the suite ran.
process.env.DEEPSEEK_API_KEY = PREV_KEY;

// A model body that smuggles in a tracking pixel and a spam link the prompt
// forbids. It introduces no new arabic digits, so it still passes numeric
// grounding — the body whitelist must remove the <img>/<a> on structural
// grounds, proving the hardening is independent of the grounding check.
const BODY_WITH_TRACKERS =
  OK_BODY_HTML +
  '<img src="https://t.example/pixel.png" alt="track">' +
  '<a href="https://spam.example/buy">详情点此</a>';

test("deepSeekAdapt: model <img>/<a> trackers are stripped by the body whitelist", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  const r = await deepSeekAdapt({
    source,
    fetcher: makeFetcher(okModelJson({ content: BODY_WITH_TRACKERS, summary: OK_SUMMARY })),
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(!r.content.includes("<img"), "no <img> in adapted body");
    assert.ok(!r.content.includes("<a"), "no <a> in adapted body");
    assert.ok(!r.content.includes("href"), "no href attribute survives");
    assert.ok(!r.content.includes("t.example"), "tracker host gone");
    assert.ok(!r.content.includes("spam.example"), "spam host gone");
    assert.ok(r.content.includes("详情点此"), "anchor text kept as plain text");
  }
});
