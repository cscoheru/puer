import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DELTAS,
  STAGES,
  STAGE_LABELS,
  DELTA_LABELS,
  VESSELS,
  normalizeStage,
  normalizeDelta,
  normalizeForMatch,
  groundGrams,
  groundVessel,
  groundDescriptors,
} from "./vocab.ts";

test("词表：阶段与比较结果的中文标签齐全", () => {
  for (const s of STAGES) assert.ok(STAGE_LABELS[s], `${s} 缺标签`);
  for (const d of DELTAS) assert.ok(DELTA_LABELS[d], `${d} 缺标签`);
  assert.ok(VESSELS.length >= 8);
});

test("normalizeStage：英文值、中文同义词、垃圾输入", () => {
  assert.equal(normalizeStage("peak"), "peak");
  assert.equal(normalizeStage("PEAK"), "peak");
  assert.equal(normalizeStage("巅峰期"), "peak");
  assert.equal(normalizeStage("还在转化"), "ascending");
  assert.equal(normalizeStage("走下坡路"), "declining");
  assert.equal(normalizeStage(""), null);
  assert.equal(normalizeStage(null), null);
  assert.equal(normalizeStage("好像还行"), null, "无法识别必须返回 null，不许猜");
});

test("normalizeDelta：三档映射", () => {
  assert.equal(normalizeDelta("better"), "better");
  assert.equal(normalizeDelta("更好"), "better");
  assert.equal(normalizeDelta("持平"), "same");
  assert.equal(normalizeDelta("不如上次"), "worse");
  assert.equal(normalizeDelta("undefined"), null);
});

test("normalizeForMatch：全角数字、HTML、空白", () => {
  assert.equal(normalizeForMatch("<p>７克</p>"), "7克");
  assert.equal(normalizeForMatch("  7  克  "), "7 克");
  assert.equal(normalizeForMatch("&nbsp;茶"), "茶");
  assert.equal(normalizeForMatch(null), "");
});

test("groundGrams：只认数字紧跟克/g，避免年份误判", () => {
  assert.equal(groundGrams(7, "投茶7克"), 7);
  assert.equal(groundGrams(7.5, "投茶 7.5g"), 7.5);
  assert.equal(groundGrams(8, "投茶８克"), 8, "全角数字也要认");
  assert.equal(groundGrams(1987, "这是1987年的茶"), null, "1987年不是投茶量");
  assert.equal(groundGrams(7, "投茶量大"), null, "没写数字不能认");
  assert.equal(groundGrams(200, "投茶200克"), null, "超出合理区间视为噪声");
  assert.equal(groundGrams("abc", "投茶7克"), null);
});

test("groundVessel：取最长匹配，且只认原文出现的器具", () => {
  assert.equal(groundVessel("紫砂", "用紫砂壶泡"), "紫砂壶", "宽泛词取完整词");
  assert.equal(groundVessel("盖碗", "盖碗冲泡"), "盖碗");
  // 模型说错时以原文为准：原文确实用了盖碗，这个事实是可信的
  assert.equal(groundVessel("瓷壶", "用盖碗泡"), "盖碗");
  assert.equal(groundVessel(null, "用盖碗泡"), "盖碗", "模型没给也能从原文取");
  assert.equal(groundVessel(null, "6.7克130cc壶"), "壶", "认不出材质也要记下原文写明的器具");
  assert.equal(groundVessel("瓷壶", "随便泡的"), null, "原文没有任何器具 → null");
});

test("groundDescriptors：原文没写的词一律丢弃", () => {
  const text = "汤色橙黄透亮，蜜韵明显，回甘快，水路细";
  const got = groundDescriptors(["蜜韵", "回甘", "烟香", "水路细"], text);
  assert.deepEqual(got, ["蜜韵", "回甘", "水路细"]);
  assert.deepEqual(groundDescriptors("蜜韵、烟香", text), ["蜜韵"]);
  assert.deepEqual(groundDescriptors([], text), []);
  assert.deepEqual(groundDescriptors([123, null, "蜜韵"], text), ["蜜韵"]);
});

test("groundDescriptors：不让 HTML 片段进数据层", () => {
  const text = "汤色<b>橙黄</b>，蜜韵";
  assert.deepEqual(groundDescriptors(["<b>", "橙黄", "蜜韵"], text), ["橙黄", "蜜韵"]);
});
