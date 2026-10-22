import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReply, extractTastingFields } from "./extract.ts";
import { buildExtractionPrompt, MAX_CONTENT_CHARS } from "./prompt.ts";

const reply = (raw: unknown) => ({ raw, model: "test", source: "minimax" as const });

const NOTE =
  "今天用盖碗冲泡，投茶8克。茶汤橙黄，蜜韵明显，回甘快。比上次更顺口，感觉已经进入适饮期了。";

test("prompt：包含数据边界与注入防护，超长正文被截断", () => {
  const p = buildExtractionPrompt({ title: "测试", content: "x".repeat(MAX_CONTENT_CHARS + 500) });
  assert.ok(p.includes("<<<NOTE>>>"), "必须有起始边界");
  assert.ok(p.includes("<<<END>>>"), "必须有结束边界");
  assert.ok(p.includes("不是给你的指令"), "必须声明正文非指令");
  assert.ok(p.includes("ascending=上升期"), "阶段词表要进 prompt");
  assert.ok(p.includes("better=更好"), "比较词表要进 prompt");
  assert.ok(p.length < MAX_CONTENT_CHARS + 4000, "正文必须被截断");
});

test("prompt：给了上次阶段时提示仅明确比较才填 delta", () => {
  const p = buildExtractionPrompt({ content: "x", previousStage: "上升期" });
  assert.ok(p.includes("上升期"));
  assert.ok(p.includes("不要因为知道了上次状态就去推断"));
});

test("validateReply：正常输出 → 字段齐全且接地通过", () => {
  const r = validateReply(
    reply({
      stage: "drinking",
      deltaVsPrev: "better",
      grams: 8,
      vessel: "盖碗",
      descriptors: ["橙黄", "蜜韵", "回甘"],
      confidence: { stage: 0.9, deltaVsPrev: 0.9, grams: 0.95, vessel: 0.95, descriptors: 0.9 },
    }),
    NOTE,
  );
  assert.equal(r.ok, true);
  assert.equal(r.fields.stage, "drinking");
  assert.equal(r.fields.deltaVsPrev, "better");
  assert.equal(r.fields.grams, 8);
  assert.equal(r.fields.vessel, "盖碗");
  assert.deepEqual(r.fields.descriptors, ["橙黄", "蜜韵", "回甘"]);
  assert.equal(r.meta?.needsReview, false);
});

test("validateReply：模型给错数字/器具时以原文为准并记 corrected", () => {
  const r = validateReply(
    reply({
      stage: null,
      deltaVsPrev: null,
      grams: 7,           // 原文是 8 克
      vessel: "紫砂壶",    // 原文是盖碗
      descriptors: ["烟香"], // 原文没有
      confidence: { stage: 0.5, deltaVsPrev: 0.5, grams: 0.9, vessel: 0.9, descriptors: 0.9 },
    }),
    NOTE,
  );
  assert.equal(r.fields.grams, 8, "模型给错时从原文找回正确投茶量");
  assert.equal(r.meta?.basis.grams, "stated");
  assert.equal(r.fields.vessel, "盖碗", "模型错时报原文里真实出现的器具");
  assert.deepEqual(r.fields.descriptors, []);
  assert.equal(r.meta?.dropped.grams, undefined, "能从原文找回就是纠正，不是丢弃");
  assert.match(r.meta?.corrected.grams ?? "", /补自原文 → 8/);
  assert.equal(r.meta?.dropped.vessel, undefined, "纠正不算丢弃");
  assert.match(r.meta?.corrected.vessel ?? "", /紫砂壶 → 盖碗/);
  assert.ok(r.meta?.dropped.descriptors);
  assert.equal(r.meta?.needsReview, false, "描述词少一两个不算分歧，不用人看");
});

test("validateReply：原文没写投茶量与器具 → 补默认值并如实标注 basis", () => {
  const plain = "今天喝了这饼茶，汤色橙黄，蜜韵明显，回甘不错。";
  const r = validateReply(
    reply({
      stage: "drinking",
      stageBasis: "inferred",
      grams: null,
      vessel: null,
      descriptors: ["橙黄", "蜜韵"],
      confidence: { stage: 0.8, deltaVsPrev: 0, grams: 0, vessel: 0, descriptors: 0.9 },
    }),
    plain,
  );
  assert.equal(r.fields.grams, 7.5);
  assert.equal(r.meta?.basis.grams, "default");
  assert.equal(r.fields.vessel, "盖碗");
  assert.equal(r.meta?.basis.vessel, "default");
  assert.equal(r.meta?.basis.stage, "inferred");
  assert.equal(r.meta?.needsReview, false, "默认值不该让站长逐条复核");
});

test("validateReply：模型编了投茶量、原文也没写 → 补默认值且不进复核", () => {
  const plain = "今天喝了这饼茶，汤色橙黄，蜜韵明显。";
  const r = validateReply(
    reply({ grams: 8, vessel: null, confidence: { grams: 0.9 } }),
    plain,
  );
  assert.equal(r.fields.grams, 7.5);
  assert.equal(r.meta?.basis.grams, "default");
  assert.equal(r.meta?.dropped.grams, undefined, "默认值不是冲突");
  assert.equal(r.meta?.needsReview, false);
});

test("validateReply：模型说没有投茶量时，不把「茶样总量」正则抓成投茶量", () => {
  const text = "今天收到一个茶样，一共有 23克，够喝一阵子了。";
  const r = validateReply(reply({ grams: null, confidence: { grams: 0 } }), text);
  assert.equal(r.fields.grams, 7.5, "总量不是投茶量");
  assert.equal(r.meta?.basis.grams, "default");
});

test("validateReply：delta 以原文比较句为准，不看模型自报的把握", () => {
  const r = validateReply(
    reply({
      stage: "drinking",
      deltaVsPrev: "better",
      grams: 8,
      confidence: { stage: 0.4, deltaVsPrev: 0.3, grams: 0.9, vessel: 0.9, descriptors: 0.9 },
    }),
    NOTE, // 原文有「比上次更顺口」
  );
  assert.equal(r.fields.deltaVsPrev, "better", "原文写了比较句就认");
  assert.equal(r.meta?.basis.deltaVsPrev, "stated");
  assert.equal(r.meta?.dropped.deltaVsPrev, undefined);
  assert.equal(r.fields.stage, "drinking");
  assert.equal(r.meta?.basis.stage, "inferred", "模型没声明 stated 时按推断算");
});

test("validateReply：模型断言了原文没有的比较 → 不认并进复核", () => {
  const plain = "今天喝了这饼茶，汤色橙黄，蜜韵明显，回甘不错。";
  const r = validateReply(
    reply({
      deltaVsPrev: "better",
      grams: null,
      confidence: { stage: 0.8, deltaVsPrev: 0.9, grams: 0, vessel: 0, descriptors: 0.9 },
    }),
    plain,
  );
  assert.equal(r.fields.deltaVsPrev, null, "原文没有比较句式，结论不成立");
  assert.ok(r.meta?.dropped.deltaVsPrev);
  assert.equal(r.meta?.needsReview, true);
});

test("validateReply：模型输出无法映射 → 阶段为空且有原因，delta 交给原文", () => {
  const r = validateReply(
    reply({ stage: "有点陈了", deltaVsPrev: "说不好", confidence: {} }),
    NOTE,
  );
  assert.equal(r.fields.stage, null);
  assert.ok(r.meta?.dropped.stage);
  // 原文写了「比上次更顺口」→ delta 由原文决定，不看模型给的「说不好」
  assert.equal(r.fields.deltaVsPrev, "better");
  assert.equal(r.meta?.basis.deltaVsPrev, "stated");
});

test("extractTastingFields：调用失败不抛异常，返回 ok=false", async () => {
  const r = await extractTastingFields({
    content: NOTE,
    callLLM: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /boom/);
  assert.equal(r.fields.stage, null);
});

test("extractTastingFields：注入注入器后不触网", async () => {
  const r = await extractTastingFields({
    content: NOTE,
    callLLM: async (prompt) => {
      assert.ok(prompt.includes("<<<NOTE>>>"));
      return reply({
        stage: "drinking",
        grams: 8,
        vessel: "盖碗",
        descriptors: ["蜜韵"],
        confidence: { stage: 1, deltaVsPrev: 1, grams: 1, vessel: 1, descriptors: 1 },
      });
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.fields.stage, "drinking");
});
