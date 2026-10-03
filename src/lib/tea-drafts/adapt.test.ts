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
  dropReferenceParagraphs,
  extractNumberTokens,
  isGrounded,
  checkAdaptLength,
  deepSeekAdapt,
} from "./adapt.ts";
import { styleFor } from "./styles.ts";
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
    teaName: null,
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

// Inject a fetcher returning an OpenAI-shaped body. `content` is the raw
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

/**
 * Fetcher that returns a valid model response AND records the request body sent
 * to the model, so prompt content — the 资料/品鉴 separation instruction and the
 * style voice — can be asserted on without a real network call. The prompt is
 * where this whole cut's main fix lives, so leaving it unasserted would let a
 * refactor delete the instruction and keep every test green.
 */
function captureFetcher(json: unknown, sink: { body?: string }): FetchLike {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    sink.body = typeof init?.body === "string" ? init.body : "";
    return makeFetcher(json)("http://local.invalid/");
  }) as FetchLike;
}

// Save/restore the key so this file never leaks env state.
const PREV_KEY = process.env.MINIMAX_API_KEY;
process.env.MINIMAX_API_KEY = "test-key";

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

test("checkAdaptLength: within [0.2x, 2.0x] and ≥60 → ok", () => {
  assert.equal(checkAdaptLength(100, 100).ok, true); // 1.0x
  assert.equal(checkAdaptLength(60, 300).ok, true); // 0.2x exactly
  assert.equal(checkAdaptLength(200, 100).ok, true); // 2.0x exactly
  // The 资料-heavy case: a rewrite that discards reference prose is legitimately
  // far shorter than its source, which is why the floor is 0.2 and not 0.3.
  assert.equal(checkAdaptLength(120, 500).ok, true); // 0.24x
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

test("checkAdaptLength: ratio below 0.2x → rejected (trims too aggressively)", () => {
  // 70cp clears the absolute min(60) but 70/400 = 0.18x < 0.2x floor → rejected.
  const r = checkAdaptLength(70, 400);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /0\.17x < 0\.2x/);
});

test("checkAdaptLength: ratio above 2.0x → rejected (rambling)", () => {
  const r = checkAdaptLength(250, 100); // 2.5x
  assert.equal(r.ok, false);
  // Note the reason interpolates the raw constant (2.0 prints as "2").
  assert.match((r as { reason: string }).reason, /> 2x of source/);
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
    style: "veteran",
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
    style: "veteran",
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
    style: "veteran",
    fetcher: makeFetcher(okModelJson({ content: body2024, summary: "回甘不错" })),
  });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /ungrounded number: 2024/);
});

test("deepSeekAdapt: a fabricated number in the SUMMARY → rejected (body+summary grounding)", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 })); // no 95 in source
  const r = await deepSeekAdapt({
    source,
    style: "veteran",
    fetcher: makeFetcher(okModelJson({ content: OK_BODY_HTML, summary: "我给95分" })),
  });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /ungrounded number: 95/);
});

test("deepSeekAdapt: too-short body → rejected", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  const r = await deepSeekAdapt({
    source,
    style: "veteran",
    fetcher: makeFetcher(okModelJson({ content: "<p>短。</p>", summary: "还行" })),
  });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /too short/);
});

test("deepSeekAdapt: non-JSON model content → rejected", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  const r = await deepSeekAdapt({
    source,
    style: "veteran",
    fetcher: makeFetcher(dsBody("not json at all")),
  });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /no JSON object/);
});

test("deepSeekAdapt: empty content → rejected", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  const r = await deepSeekAdapt({
    source,
    style: "veteran",
    fetcher: makeFetcher(okModelJson({ content: "   ", summary: "x" })),
  });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /empty content or summary/);
});

test("deepSeekAdapt: HTTP non-ok → rejected with status", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  const r = await deepSeekAdapt({ source, style: "veteran", fetcher: makeFetcher({}, 500) });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /MiniMax 500/);
});

test("deepSeekAdapt: fetch throws → rejected, never throws", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  const throwing = (async () => {
    throw new Error("boom");
  }) as FetchLike;
  const r = await deepSeekAdapt({ source, style: "veteran", fetcher: throwing });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /fetch error: boom/);
});

test("deepSeekAdapt: missing API key → rejected (fail-closed)", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  delete process.env.MINIMAX_API_KEY;
  try {
    const r = await deepSeekAdapt({
      source,
      style: "veteran",
    fetcher: makeFetcher(okModelJson({ content: OK_BODY_HTML, summary: OK_SUMMARY })),
    });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /MINIMAX_API_KEY missing/);
  } finally {
    process.env.MINIMAX_API_KEY = "test-key";
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
    style: "veteran",
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

// ─── reference-paragraph filter ─────────────────────────────────────────

test("dropReferenceParagraphs: drops a leading bracketed 资料 paragraph", () => {
  const kept = dropReferenceParagraphs([
    "（资料）此茶1997年由某厂生产,市场俗称老树圆茶。",
    "今天开汤,汤色橙红。",
    "(资料) 行情价另计。",
    "【资料】批次考据略。",
    "回甘不错。",
  ]);
  assert.deepEqual(kept, ["今天开汤,汤色橙红。", "回甘不错。"]);
});

test("dropReferenceParagraphs: a mid-paragraph mention of 资料 is kept", () => {
  // The marker has to lead the paragraph — dropping on any occurrence would
  // throw away the author's own sentence that merely says the word.
  const kept = dropReferenceParagraphs(["这份资料不全,但茶还是好喝。", "尾水略涩。"]);
  assert.deepEqual(kept, ["这份资料不全,但茶还是好喝。", "尾水略涩。"]);
});

test("dropReferenceParagraphs: pure and order-preserving", () => {
  const input = ["（资料）x", "a", "（资料）y", "b"];
  const before = [...input];
  const kept = dropReferenceParagraphs(input);
  assert.deepEqual(kept, ["a", "b"]);
  assert.deepEqual(input, before, "input was mutated");
});

test("toAdaptSource: drops 资料 paragraphs from prompt text AND from the length baseline", () => {
  // The three views must agree. If the reference paragraph stayed in
  // `plainText`, a correct rewrite of a 资料-heavy note would be measured against
  // prose the prompt just told the model to discard — and fail the ratio floor
  // for doing exactly what was asked.
  const src = toAdaptSource(
    nn({
      content:
        "<p>（资料）此茶1997年由某厂生产,当年行情价每饼380元,市场俗称老树圆茶。</p>" +
        "<p>今天开汤,汤色橙红透亮,入口有樟香,回甘快,尾水略涩。</p>",
    }),
  );
  assert.ok(!src.plainText.includes("1997"), "reference number left in baseline");
  assert.ok(!src.plainText.includes("380"), "reference price left in baseline");
  assert.ok(src.plainText.includes("樟香"), "own tasting facts dropped");
  assert.ok(!src.corpus.includes("1997"), "reference number left in grounding corpus");
  assert.ok(src.corpus.includes("橙红"), "own tasting facts dropped from corpus");
});

test("toAdaptSource: the tea product name reaches the prompt AND the grounding corpus", () => {
  // The article's title is the tea name (assemble.ts), not the note's log line.
  // The model has to know the name it is writing under, and — this is the sharp
  // half — the name must be licensed as a source fact. Product names carry
  // digits (「97老树圆茶」), so a name outside the corpus would make `isGrounded`
  // reject the output for stating the article's own title.
  const src = toAdaptSource(nn({ title: "2026开汤第3场", teaName: "97老树圆茶" }));
  assert.equal(src.teaName, "97老树圆茶");
  assert.equal(src.title, "2026开汤第3场", "note title must stay distinct from the product name");
  assert.ok(src.corpus.includes("97老树圆茶"), "product name missing from grounding corpus");
  assert.ok(src.corpus.includes("2026开汤第3场"), "note title dropped from grounding corpus");
});

test("deepSeekAdapt: the product name is in the prompt, and its digits are grounded", async () => {
  const sink: { body?: string } = {};
  const source = toAdaptSource(
    nn({ title: "2026开汤第3场", teaName: "97老树圆茶", waterTemp: 100, steepCount: 7 }),
  );
  const bodyWithName =
    "<p>97老树圆茶汤色橙红透亮,香气沉稳,入口顺滑饱满,回甘持久,耐泡度不错;" +
    "不足是尾水略带涩感。冲泡用100度热水、投茶7克,整体表现稳定。</p>";
  const r = await deepSeekAdapt({
    source,
    style: "veteran",
    fetcher: captureFetcher(okModelJson({ content: bodyWithName, summary: OK_SUMMARY }), sink),
  });
  // Before the name joined the corpus this body was rejected: "97" appeared in
  // the output but nowhere the policer looked. Writing the title of the piece
  // must never be the thing that fails the rewrite.
  assert.equal(r.ok, true, r.ok ? "" : `rewrite rejected: ${(r as { reason: string }).reason}`);
  const sent = sink.body ?? "";
  assert.ok(sent.includes("茶品:97老树圆茶"), "prompt did not name the product");
  assert.ok(sent.includes("笔记标题:2026开汤第3场"), "prompt lost the note's own title");
});

// ─── prompt content (separation instruction + style voice) ──────────────

test("deepSeekAdapt: the prompt carries the 资料/品鉴 separation instruction", async () => {
  const sink: { body?: string } = {};
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  await deepSeekAdapt({
    source,
    style: "veteran",
    fetcher: captureFetcher(okModelJson({ content: OK_BODY_HTML, summary: OK_SUMMARY }), sink),
  });
  const sent = sink.body ?? "";
  // This is the fix for 「把（资料）也转述过来」. If either half of the A/B split
  // disappears from the prompt, the draft goes back to transcribing reference
  // material — and no other test would notice.
  assert.ok(sent.includes("A. 资料性内容"), "prompt lost the A (reference) half");
  assert.ok(sent.includes("B. 作者本人的品鉴事实"), "prompt lost the B (tasting) half");
  assert.ok(sent.includes("只写 B"), "prompt lost the keep-only-B rule");
  assert.ok(sent.includes("一律丢弃"), "prompt lost the discard rule");
  assert.ok(sent.includes("不要转述"), "prompt lost the no-transcription rule");
});

test("deepSeekAdapt: the prompt carries the dispatched style voice", async () => {
  const sink: { body?: string } = {};
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  await deepSeekAdapt({
    source,
    style: "caveat",
    fetcher: captureFetcher(okModelJson({ content: OK_BODY_HTML, summary: OK_SUMMARY }), sink),
  });
  const sent = sink.body ?? "";
  assert.ok(sent.includes("避坑测评"), "style label missing from prompt");
  assert.ok(sent.includes("劝退点"), "style voice missing from prompt");
  assert.ok(!sent.includes("朋友圈"), "wrong style voice leaked into the prompt");
});

test("deepSeekAdapt: success echoes back the style it was given", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  const r = await deepSeekAdapt({
    source,
    style: "story",
    fetcher: makeFetcher(okModelJson({ content: OK_BODY_HTML, summary: OK_SUMMARY })),
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.style, "story");
});

test("deepSeekAdapt: unknown style key → rejected, never throws", async () => {
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  const r = await deepSeekAdapt({
    source,
    style: "not-a-style" as never,
    fetcher: makeFetcher(okModelJson({ content: OK_BODY_HTML, summary: OK_SUMMARY })),
  });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /unknown style/);
});

test("deepSeekAdapt: styleFor(noteId) is accepted for every style in the set", async () => {
  // Smoke the join between the dispatch hash and the adapter: every style the
  // hash can emit must be a style the adapter will actually run.
  const source = toAdaptSource(nn({ waterTemp: 100, steepCount: 7 }));
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) {
    const s = styleFor(`note-${i}`);
    seen.add(s.key);
    const r = await deepSeekAdapt({
      source,
      style: s.key,
      fetcher: makeFetcher(okModelJson({ content: OK_BODY_HTML, summary: OK_SUMMARY })),
    });
    assert.equal(r.ok, true, `style ${s.key} was rejected`);
  }
  assert.equal(seen.size, 5, `only ${seen.size} styles exercised`);
});
