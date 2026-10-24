import { test } from "node:test";
import assert from "node:assert/strict";

import { cleanTeaName, sortTeasForMerge } from "./tea-name-clean.ts";

test("去掉来源标记前缀（展示用）", () => {
  assert.equal(cleanTeaName("（资料）2004年班章青饼"), "2004年班章青饼");
  assert.equal(cleanTeaName("【天天论普】_ 95青饼7542"), "95青饼7542");
  assert.equal(cleanTeaName("【天天论普】01年明星茶集锦"), "01年明星茶集锦");
  assert.equal(cleanTeaName("2003-班章四星孔雀"), "2003-班章四星孔雀");
});

test("剥空了要退回原名（总比显示空白强）", () => {
  assert.equal(cleanTeaName("（资料）"), "（资料）");
  assert.equal(cleanTeaName(""), "");
});

test("排序：拼音为主、同名时年份为辅", () => {
  const list = [
    { name: "2004-班章四星孔雀", year: 2004 },
    { name: "2003-班章四星孔雀", year: 2003 },
    { name: "2004-班章六星孔雀", year: 2004 },
  ];
  const sorted = sortTeasForMerge(list);
  // 同名不同年：2003 在前
  assert.equal(sorted[0].year, 2003);
  // 同年的按拼音（班章六星 < 班章四星）
  assert.equal(cleanTeaName(sorted[1].name), "2004-班章六星孔雀");
  assert.equal(cleanTeaName(sorted[2].name), "2004-班章四星孔雀");
});

test("排序不受来源前缀影响（带前缀的与不带的是同一组）", () => {
  const list = [
    { name: "（资料）2004-班章四星孔雀", year: 2004 },
    { name: "2004-班章四星孔雀", year: 2004 },
  ];
  const sorted = sortTeasForMerge(list);
  assert.equal(cleanTeaName(sorted[0].name), "2004-班章四星孔雀");
  assert.equal(cleanTeaName(sorted[1].name), "2004-班章四星孔雀");
});

test("排序不改动原数组", () => {
  const list = [
    { name: "2004-b", year: 2004 },
    { name: "2004-a", year: 2004 },
  ];
  sortTeasForMerge(list);
  assert.equal(list[0].name, "2004-b", "原数组不该被改");
});
