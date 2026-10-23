import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDescriptorCell,
  parseCsv,
  planCorrections,
  toCsv,
  type CurrentValues,
} from "./tasting-corrections.ts";

const current = (over: Partial<CurrentValues> = {}): CurrentValues => ({
  id: "n1",
  stage: "drinking",
  deltaVsPrev: null,
  grams: 7.5,
  vessel: "盖碗",
  descriptors: ["蜜香", "回甘"],
  ...over,
});

test("留空 = 不改；值没变也不算改动", () => {
  const p = planCorrections({ id: "n1" }, current());
  assert.equal(p.changed, false);
  assert.deepEqual(p.changes, {});

  const same = planCorrections({ id: "n1", stage: "drinking", grams: "7.5" }, current());
  assert.equal(same.changed, false, "值一样就不该写库");
});

test("`-` 清空字段（本来就为空的不算改动）", () => {
  const p = planCorrections({ id: "n1", stage: "-", delta: "-" }, current());
  assert.equal(p.changes.stage, null);
  assert.equal(p.changes.deltaVsPrev, undefined, "库里本来就是 null，没什么可清");
  assert.deepEqual(p.manualFields, ["stage"]);

  const q = planCorrections({ id: "n1", delta: "-" }, current({ deltaVsPrev: "worse" }));
  assert.equal(q.changes.deltaVsPrev, null);
});

test("stage / delta 接受英文与中文，认不出的报错且不写入", () => {
  const p = planCorrections({ id: "n1", stage: "走下坡", delta: "better" }, current());
  assert.equal(p.changes.stage, "declining");
  assert.equal(p.changes.deltaVsPrev, "better");

  const bad = planCorrections({ id: "n1", stage: "说不好" }, current());
  assert.equal(bad.changed, false);
  assert.match(bad.errors[0], /stage 无法识别/);
});

test("grams 必须是 0–100 的数字", () => {
  assert.equal(planCorrections({ id: "n1", grams: "8" }, current()).changes.grams, 8);
  assert.equal(planCorrections({ id: "n1", grams: "8克" }, current()).changes.grams, 8);
  const bad = planCorrections({ id: "n1", grams: "三百" }, current());
  assert.equal(bad.changed, false);
  assert.match(bad.errors[0], /grams 不合理/);
});

test("器具超长报错（列宽 40）", () => {
  const long = "盖".repeat(41);
  const p = planCorrections({ id: "n1", vessel: long }, current());
  assert.equal(p.changed, false);
  assert.match(p.errors[0], /器具太长/);
});

test("描述词：逗号分段，顿号在词内部时不拆", () => {
  const cur = current({ descriptors: ["甜、柔且均衡", "蜜香"] });
  const p = planCorrections({ id: "n1", descriptors: "甜、柔且均衡,新词" }, cur);
  assert.deepEqual(p.changes.descriptors, ["甜、柔且均衡", "新词"]);
});

test("描述词：拆出的碎片若都在库里就按碎片收（值没变就不写）", () => {
  const cur = current({ descriptors: ["甜", "柔"] });
  const p = planCorrections({ id: "n1", descriptors: "甜、柔" }, cur);
  assert.equal(p.changes.descriptors, undefined, "拆回来跟库里一样，不算改动");
  assert.equal(p.changed, false);
});

test("parseDescriptorCell：空串得空数组", () => {
  assert.deepEqual(parseDescriptorCell("", []), []);
  assert.deepEqual(parseDescriptorCell("   ", null), []);
});

test("CSV 往返：引号与逗号都能还原", () => {
  const csv = toCsv(["id", "标题"], [["a", '他说,"这是"标题'], ["b", "含,逗号"]]);
  const back = parseCsv(csv);
  assert.deepEqual(back.header, ["id", "标题"]);
  assert.equal(back.rows[0]["标题"], '他说,"这是"标题');
  assert.equal(back.rows[1]["标题"], "含,逗号");
});

test("CSV 解析：BOM 与空行", () => {
  const parsed = parseCsv('﻿id,stage\n\nn1,peak\n');
  assert.deepEqual(parsed.header, ["id", "stage"]);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].stage, "peak");
});
