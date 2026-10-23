import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 茶仓列表的分页契约。
 *
 * 这条线出过真事故：348b6f6 把 `const requestedPage = ...` 那一行删掉了，
 * 却把 `paginationCapped(requestedPage, page)` 留在响应里 ——
 * **每次**列表请求都抛 ReferenceError，整个「我的茶仓」列表页是 500。
 *
 * 当时 tsc 一声不吭（闸门哑了，详见 typecheck-gate.test.ts），所以这条
 * 契约要自己钉住：接口给什么字段、客户端读什么字段，两边都得在。
 *
 * 用源码断言而不是真的调接口：仓库里没有任何测试构造 NextRequest 调
 * route handler（那需要一套 session + 数据库），而单元格里的字面量
 * 改动**不会**让这些断言变红 —— 字段名改了就该红。
 */

const ROUTE_SRC = readFileSync(
  fileURLToPath(new URL("../app/api/cellar/route.ts", import.meta.url)),
  "utf8",
);
const CLIENT_SRC = readFileSync(
  fileURLToPath(new URL("../components/cellar/cellar-list.tsx", import.meta.url)),
  "utf8",
);

test("接口把「请求页」和「实际页」分开，capped 才有意义", () => {
  assert.match(
    ROUTE_SRC,
    /const\s+requestedPage\s*=/,
    "route.ts 没有 requestedPage —— paginationCapped 拿不到参数，整个列表接口会 500",
  );
  assert.match(
    ROUTE_SRC,
    /capped:\s*paginationCapped\(\s*requestedPage\s*,\s*page\s*\)/,
    "route.ts 的 capped 不是按 (requestedPage, page) 算的 —— 客户端的收敛判定会错",
  );
});

test("接口返回客户端要用的分页字段", () => {
  for (const key of ["total", "limit", "page"]) {
    assert.match(
      ROUTE_SRC,
      new RegExp(`\\b${key}\\s*,`),
      `接口的响应里没有 ${key} —— 客户端算不出页数`,
    );
  }
});

test("客户端读的字段名与接口返回的一致", () => {
  for (const key of ["data.total", "data.limit", "data.page"]) {
    assert.ok(
      CLIENT_SRC.includes(key),
      `客户端没读 ${key} —— 接口改了字段名不会有人发现`,
    );
  }
});
