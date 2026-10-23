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
 * 契约要自己钉住。
 *
 * 用源码断言而不是真的调接口：仓库里没有任何测试构造 NextRequest 调
 * route handler（那需要一套 session + 数据库），而单元格里的字面量
 * 改动**不会**让这些断言变红 —— 字段名改了就该红。
 */

const ROUTE_SRC = readFileSync(
  fileURLToPath(new URL("../app/api/cellar/route.ts", import.meta.url)),
  "utf8",
);

/** GET 处理器返回的那个响应对象 —— 别的 NextResponse.json 不算。 */
function getResponseBody(): string {
  const getStart = ROUTE_SRC.indexOf("export async function GET");
  const getEnd = ROUTE_SRC.indexOf("export async function POST", getStart);
  assert.ok(getStart >= 0 && getEnd > getStart, "route.ts 里找不到 GET 处理器");
  const block = ROUTE_SRC.slice(getStart, getEnd);
  const m = block.match(/NextResponse\.json\(\{([\s\S]*?)\n\s*\}\)/);
  assert.ok(m, "GET 处理器里找不到 NextResponse.json 的响应对象");
  return m[1];
}

test("接口把「请求页」和「实际页」分开，capped 才有意义", () => {
  assert.match(
    ROUTE_SRC,
    /const\s+requestedPage\s*=\s*parseRequestedPage\(/,
    "route.ts 没有用 parseRequestedPage 解析请求页 —— capped 拿不到请求页就失去意义",
  );
  assert.match(
    ROUTE_SRC,
    /capped:\s*paginationCapped\(\s*requestedPage\s*,\s*page\s*\)/,
    "route.ts 的 capped 不是按 (requestedPage, page) 算的 —— 客户端的收敛判定会错",
  );
});

test("接口返回客户端算页数要用的字段", () => {
  const body = getResponseBody();
  for (const key of ["total", "limit", "page"]) {
    assert.match(
      body,
      new RegExp(`\\b${key}\\b`),
      `响应里没有 ${key} —— 客户端算不出页数`,
    );
  }
});
