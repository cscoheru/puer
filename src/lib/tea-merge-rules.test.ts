import { test } from "node:test";
import assert from "node:assert/strict";

import {
  groupSameNameTeas,
  pickMergeDirection,
  type MergeCandidate,
} from "./tea-merge-rules.ts";
// 用**真实**的名字清洗函数（来源标记是前缀：「（资料）2004年班章青饼」）
import { cleanTeaName } from "./tea-name-clean.ts";

const tea = (
  id: string,
  refs: number,
  isClassic = false,
  name = "同名茶",
): MergeCandidate => ({ id, name, isClassic, refs });

// ─── 合并方向 ───────────────────────────────────────────────────────────

test("引用多的一条留下，引用少的并入", () => {
  const { keep, drop } = pickMergeDirection(tea("a", 3), tea("b", 1));
  assert.equal(keep.id, "a");
  assert.equal(drop.id, "b");
});

test("经典优先（经典是站长亲自选的，不能被合并掉）", () => {
  const { keep, drop } = pickMergeDirection(tea("a", 10, false), tea("b", 0, true));
  assert.equal(keep.id, "b", "经典那���哪怕一条笔记都没有也要留下");
  assert.equal(drop.id, "a");
});

test("两个都是经典 → 按引用数", () => {
  const { keep } = pickMergeDirection(tea("a", 1, true), tea("b", 5, true));
  assert.equal(keep.id, "b");
});

test("引用数相同时保持稳定（a 留下）", () => {
  const { keep, drop } = pickMergeDirection(tea("a", 2), tea("b", 2));
  assert.equal(keep.id, "a");
  assert.equal(drop.id, "b");
});

// ─── 同名分组 ───────────────────────────────────────────────────────────

const clean = cleanTeaName;

test("名称 + 年份 + 品牌全同才算一组", () => {
  const groups = groupSameNameTeas(
    [
      { id: "1", name: "2004年班章青饼", year: 2004, brand: "大益" },
      { id: "2", name: "2004年班章青饼", year: 2004, brand: "大益" },
      { id: "3", name: "2004年班章青饼", year: 2005, brand: "大益" },
      { id: "4", name: "2004年班章青饼", year: 2004, brand: "老同志" },
    ],
    clean,
  );
  assert.equal(groups.length, 1, "只有全同的那两条成组");
  assert.deepEqual(groups[0].ids, ["1", "2"]);
});

test("来源前缀剥掉后算同一个名字", () => {
  const groups = groupSameNameTeas(
    [
      { id: "1", name: "2004年班章青饼", year: 2004, brand: "大益" },
      { id: "2", name: "（资料）2004年班章青饼", year: 2004, brand: "大益" },
      { id: "3", name: "【天天论普】_ 2004年班章青饼", year: 2004, brand: "大益" },
    ],
    clean,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].ids.length, 3);
});

test("「我所了解的大益茶」那种同名不同年份品牌的不能成组", () => {
  // 生产库里的真事：三条同名，年份 0/2000/2000，品牌也不同。
  const groups = groupSameNameTeas(
    [
      { id: "1", name: "我所了解的大益茶", year: 0, brand: "大益" },
      { id: "2", name: "我所了解的大益茶", year: 2000, brand: "测试品牌" },
      { id: "3", name: "我所了解的大益茶", year: 2000, brand: "测试品牌" },
    ],
    clean,
  );
  assert.equal(groups.length, 1, "只有那两条全同的成组");
  assert.deepEqual(groups[0].ids, ["2", "3"]);
});

test("只有一条的不成组", () => {
  const groups = groupSameNameTeas(
    [{ id: "1", name: "孤品", year: 2004, brand: "大益" }],
    clean,
  );
  assert.equal(groups.length, 0);
});
