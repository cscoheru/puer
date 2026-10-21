import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampListLimit,
  clampListPage,
  clampOffset,
  paginationCapped,
  MAX_PUBLIC_LIMIT,
  MAX_PUBLIC_PAGE,
  MAX_PUBLIC_OFFSET,
} from "./pagination-limits.ts";

const anon = { isAdmin: false };
const admin = { isAdmin: true };

test("limit：公开访问被夹到上限内", () => {
  assert.equal(clampListLimit("10000", anon), MAX_PUBLIC_LIMIT);
  assert.equal(clampListLimit("61", anon), MAX_PUBLIC_LIMIT);
  assert.equal(clampListLimit("60", anon), 60);
  assert.equal(clampListLimit("20", anon), 20);
});

test("limit：管理员不受限（后台要一次拉全量茶品）", () => {
  assert.equal(clampListLimit("9999", admin), 9999);
  assert.equal(clampListLimit("10000", admin), 10000);
});

test("limit：垃圾输入回落到默认值，不报错", () => {
  assert.equal(clampListLimit("abc", anon), 20);
  assert.equal(clampListLimit("", anon), 20);
  assert.equal(clampListLimit(null, anon), 20);
  assert.equal(clampListLimit("0", anon), 20);
  assert.equal(clampListLimit("-5", anon), 20);
  assert.equal(clampListLimit("NaN", anon), 20);
  // parseInt 在首个非数字处截断（"12abc" → 12）——沿用 pagination.ts 的既有
  // 约定。关键是结果永远落在合法区间内，不会变成 NaN 或超大值。
  assert.equal(clampListLimit("1e999", anon), 1);
  assert.equal(clampListLimit("60abc", anon), 60);
});

test("page：公开访问翻页深度被封顶", () => {
  assert.equal(clampListPage("99999", anon), MAX_PUBLIC_PAGE);
  assert.equal(clampListPage("51", anon), MAX_PUBLIC_PAGE);
  assert.equal(clampListPage("50", anon), 50);
  assert.equal(clampListPage("2", anon), 2);
});

test("page：管理员不受限", () => {
  assert.equal(clampListPage("99999", admin), 99999);
});

test("page：垃圾输入回落到第 1 页", () => {
  assert.equal(clampListPage("abc", anon), 1);
  assert.equal(clampListPage("-3", anon), 1);
  assert.equal(clampListPage("0", anon), 1);
  assert.equal(clampListPage(null, anon), 1);
});

test("offset：信息流滚到底有上限", () => {
  assert.equal(clampOffset("99999"), MAX_PUBLIC_OFFSET);
  assert.equal(clampOffset("300"), 300);
  assert.equal(clampOffset("0"), 0);
  assert.equal(clampOffset("abc"), 0);
  assert.equal(clampOffset("-1"), 0);
  // 管理员不受限
  assert.equal(clampOffset("99999", { isAdmin: true }), 99999);
});

test("数字与字符串两种入参等价", () => {
  assert.equal(clampListLimit(100, anon), clampListLimit("100", anon));
  assert.equal(clampListPage(3, anon), clampListPage("3", anon));
  assert.equal(clampOffset(50), clampOffset("50"));
});

test("越界标记：请求页大于实际页时为真", () => {
  assert.equal(paginationCapped(99999, MAX_PUBLIC_PAGE), true);
  assert.equal(paginationCapped(2, 2), false);
  assert.equal(paginationCapped(1, 2), false);
});
