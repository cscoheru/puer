import { test } from "node:test";
import assert from "node:assert/strict";

import { isSameTeaName, normalizeTeaName } from "./tea-name-normalize.ts";

/**
 * 归一化规则与 `scripts/import_tasting_notes.py` 的 `normalize()` **必须一致**
 * —— 那是同一套规则的 Python 版。两处互相引用，改一处要改另一处。
 *
 * 这批例子就是那份约定的「契约」：任何一边改了规则，这里就该红。
 */
test("归一化去掉分隔符，全角转半角，小写", () => {
  assert.equal(normalizeTeaName("国饮-2015"), "国饮2015");
  assert.equal(normalizeTeaName("国饮 2015"), "国饮2015");
  assert.equal(normalizeTeaName("国饮：2015"), "国饮2015");
  assert.equal(normalizeTeaName("2003-7542"), "20037542");
  assert.equal(normalizeTeaName("大益  2003"), "大益2003");
});

test("归一化去掉括号本身，但**保留括号里的内容**", () => {
  // ⚠️ 保留内容是刻意的：「2019 冰岛（生）」与「2019 冰岛（熟）」是
  // 两条不同的茶，括号内容被吃掉的话它们会归一化成同一个字符串。
  assert.equal(normalizeTeaName("2019 冰岛（生）"), "2019冰岛生");
  assert.equal(normalizeTeaName("2019 冰岛（熟）"), "2019冰岛熟");
  assert.notEqual(
    normalizeTeaName("2019 冰岛（生）"),
    normalizeTeaName("2019 冰岛（熟）"),
    "生茶与熟茶不能被归一化成同一条",
  );
});

test("归一化对空值安全", () => {
  assert.equal(normalizeTeaName(""), "");
  assert.equal(isSameTeaName("", "国饮2015"), false);
});

test("同一款茶：名字写法不同也算同一条", () => {
  assert.equal(isSameTeaName("国饮-2015", "国饮 2015"), true);
  assert.equal(isSameTeaName("2003-7542", "2003 7542"), true);
  assert.equal(isSameTeaName("国饮-2015（生茶）", "国饮-2015（熟茶）"), false);
  assert.equal(isSameTeaName("国饮-2015", "大益-2005"), false);
});
