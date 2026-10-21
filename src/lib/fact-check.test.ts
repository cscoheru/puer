import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractFactChecks,
  isFactCheckComplete,
  FACT_KIND_LABELS,
  type FactKind,
} from "./fact-check.ts";

const kinds = (html: string): FactKind[] => extractFactChecks(html).map((i) => i.kind);

test("价格句被挑出来，且带出具体金额", () => {
  const items = extractFactChecks("<p>这批 2017 年勐海熟茶当前报价 8600 元/提。</p>");
  const price = items.find((i) => i.kind === "price");
  assert.ok(price, "应挑出价格项");
  assert.match(price.matched, /8600/);
  assert.match(price.sentence, /8600/);
});

test("年份、产地、仓储、批次分别被识别", () => {
  const html =
    "<p>2017 年的勐海料，干仓存储，批次为 812，价格 5200 元。</p>";
  const found = kinds(html);
  assert.ok(found.includes("year"), "应有年份");
  assert.ok(found.includes("origin"), "应有产地");
  assert.ok(found.includes("storage"), "应有仓储");
  assert.ok(found.includes("batch"), "应有批次");
  assert.ok(found.includes("price"), "应有价格");
});

test("没有事实陈述的散文不产生勾选项", () => {
  assert.deepEqual(extractFactChecks("<p>今天天气不错，适合喝杯茶。</p>"), []);
  assert.deepEqual(extractFactChecks(""), []);
  assert.deepEqual(extractFactChecks("<p></p>"), []);
});

test("HTML 被剥离后再判句，标签不参与匹配", () => {
  const items = extractFactChecks('<p class="x">价格 <b>5200</b> 元一饼</p>');
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "price");
  assert.ok(!items[0].sentence.includes("<"), "句子应是纯文本");
  assert.ok(!items[0].sentence.includes("class"), "属性不应残留");
});

test("超长句不进入勾选项（叙述而非事实）", () => {
  const long = "<p>" + "这是一段很长的叙述。".repeat(20) + "8600 元。</p>";
  assert.deepEqual(extractFactChecks(long), []);
});

test("抽取有上限，避免审核面板被淹没", () => {
  const many = Array.from({ length: 60 }, (_, i) => `<p>第${i}批 8600 元。</p>`).join("");
  assert.ok(extractFactChecks(many).length <= 20);
});

test("同一句里的年份与价格是两条独立项", () => {
  const items = extractFactChecks("<p>2017 年的茶 8600 元一提。</p>");
  assert.equal(items.length, 2);
  assert.deepEqual(new Set(items.map((i) => i.kind)), new Set(["year", "price"]));
});

test("标签有中文名", () => {
  assert.equal(FACT_KIND_LABELS.price, "价格");
  assert.equal(FACT_KIND_LABELS.origin, "产地");
  assert.equal(FACT_KIND_LABELS.storage, "仓储");
});

test("逐项勾选：全部勾上才算完成", () => {
  const items = extractFactChecks("<p>2017 年 8600 元。</p>");
  assert.equal(items.length, 2);
  const none = new Set<string>();
  assert.equal(isFactCheckComplete(items, none), false);
  const one = new Set([items[0].id]);
  assert.equal(isFactCheckComplete(items, one), false);
  const all = new Set(items.map((i) => i.id));
  assert.equal(isFactCheckComplete(items, all), true);
});

test("没有可核对项时视为已完成", () => {
  assert.equal(isFactCheckComplete([], new Set()), true);
});

test("item id 稳定：同样输入得到同样 id", () => {
  const html = "<p>2017 年 8600 元。</p>";
  assert.deepEqual(
    extractFactChecks(html).map((i) => i.id),
    extractFactChecks(html).map((i) => i.id),
  );
});
