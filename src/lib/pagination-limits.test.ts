import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampListLimit,
  clampListPage,
  clampOffset,
  listPaginationView,
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

test("分页视图：页数夹到真能翻到的深度", () => {
  // total=5000、limit=20 → 总共 250 页，但服务端只翻得到 50。
  // 客户端直接渲染 250 的话，用户在第 50 页点「下一页」会原地打转。
  const v = listPaginationView(
    { total: 5000, limit: 20, effectivePage: 50 },
    anon,
  );
  assert.equal(v.pages, MAX_PUBLIC_PAGE);
  assert.equal(v.truncated, true);
});

test("分页视图：管理员不受翻页深度限制（与服务端一致）", () => {
  const v = listPaginationView(
    { total: 5000, limit: 20, effectivePage: 120 },
    admin,
  );
  assert.equal(v.pages, 250);
  assert.equal(v.truncated, false);
});

test("分页视图：翻得到就不算截断", () => {
  // 60 款茶、每页 20 → 3 页，全都能翻到。
  const v = listPaginationView(
    { total: 60, limit: 20, effectivePage: 3 },
    anon,
  );
  assert.equal(v.pages, 3);
  assert.equal(v.truncated, false);
});

test("分页视图：页码用服务端实际返回的那个，不夹到末页上", () => {
  // 请求第 50 页而列表只有 3 页 → 服务端返回 page=50（空列表）。
  // 夹成 3 会显示成「第 3 / 3 页」配一个空列表 —— 用户会以为自己的茶
  // 没了。宁可显示「第 50 / 3 页」这种一眼看出不对的。
  const v = listPaginationView(
    { total: 60, limit: 20, effectivePage: 50 },
    anon,
  );
  assert.equal(v.page, 50);
  assert.equal(v.pages, 3);
});

test("分页视图：页码至少是 1", () => {
  assert.equal(
    listPaginationView({ total: 60, limit: 20, effectivePage: 0 }, anon).page,
    1,
  );
  assert.equal(
    listPaginationView({ total: 60, limit: 20, effectivePage: -5 }, anon).page,
    1,
  );
});

test("分页视图：空列表也有一页", () => {
  const v = listPaginationView({ total: 0, limit: 20, effectivePage: 1 }, anon);
  assert.equal(v.pages, 1);
  assert.equal(v.page, 1);
  assert.equal(v.truncated, false);
});

test("分页视图：NaN / undefined 不会漏进页码（否则页面渲染成「第 NaN 页」）", () => {
  // typeof NaN === "number" —— 客户端的 `typeof x === "number"` 守卫
  // 拦不住 NaN，漏进去的话 pages > 1 为假，整个翻页条会凭空消失。
  const nan = listPaginationView(
    { total: NaN, limit: NaN, effectivePage: NaN },
    anon,
  );
  assert.ok(Number.isFinite(nan.page), `page 是 ${nan.page}`);
  assert.ok(Number.isFinite(nan.pages), `pages 是 ${nan.pages}`);
  assert.equal(nan.pages, 1);

  const undef = listPaginationView(
    {
      total: undefined as unknown as number,
      limit: undefined as unknown as number,
      effectivePage: undefined as unknown as number,
    },
    anon,
  );
  assert.ok(Number.isFinite(undef.page), `page 是 ${undef.page}`);
  assert.ok(Number.isFinite(undef.pages), `pages 是 ${undef.pages}`);
});
