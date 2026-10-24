import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { TEA_TIER_LABELS, teaTier, visibleTeaWhere } from "./tea-tier.ts";

// ─── 分层判定 ─────────────────────────────────────────────────────────────

test("茶品分三层：经典 / 普通 / 待整理", () => {
  assert.equal(teaTier({ isClassic: true, needsReview: false }), "classic");
  assert.equal(teaTier({ isClassic: false, needsReview: false }), "regular");
  assert.equal(teaTier({ isClassic: false, needsReview: true }), "pending");
});

test("经典优先于待整理（经典是站长亲自选的，不该被待整理吃掉）", () => {
  assert.equal(teaTier({ isClassic: true, needsReview: true }), "classic");
});

test("三层的显示名都有", () => {
  assert.deepEqual(TEA_TIER_LABELS, {
    classic: "经典",
    regular: "普通",
    pending: "待整理",
  });
});

// ─── 可见性口径（只有一份）───────────────────────────────────────────────

test("管理员看得见全部（含待整理 —— 那是他的工作台）", () => {
  assert.deepEqual(visibleTeaWhere({ id: "u1", isAdmin: true }), {});
});

test("匿名只看得到非待整理的", () => {
  assert.deepEqual(visibleTeaWhere({ id: null, isAdmin: false }), {
    needsReview: false,
  });
});

test("登录用户看得到非待整理的 + 自己建的待整理条目", () => {
  const w = visibleTeaWhere({ id: "u1", isAdmin: false });
  assert.ok(Array.isArray((w as { OR?: unknown[] }).OR), "应该是一个 OR 条件");
  const or = (w as { OR: Record<string, unknown>[] }).OR;
  assert.equal(or.length, 2);
  assert.deepEqual(or[0], { needsReview: false });
  // 自己建的那条：待整理 + 创建者是我
  assert.deepEqual(or[1], { needsReview: true, createdBy: "u1" });
});

// ─── 读点收口：每个读点都必须走同一份口径 ───────────────────────────────

/**
 * 「待整理」的茶品如果从某个读点漏出去，用户就会搜到那些重复条目 ——
 * 正是站长要解决的问题。所以每个读点都得过滤。
 *
 * 这里用**源码断言**钉住：仓库没有组件测试设施（见 AGENTS.md 的约定），
 * 但「这个文件里有没有调 visibleTeaWhere / 有没有 needsReview 过滤」是
 * 可以静态查的。
 */
const READ_POINTS: [string, RegExp][] = [
  ["src/app/api/teas/route.ts", /visibleTeaWhere|needsReview/],
  ["src/app/api/teas/[id]/route.ts", /needsReview/],
  ["src/app/(main)/tea/page.tsx", /visibleTeaWhere|needsReview/],
  ["src/app/(main)/tea/[id]/page.tsx", /needsReview/],
  ["src/lib/cellar-data.ts", /visibleTeaWhere|needsReview/],
  ["src/app/api/admin/teas/classic/route.ts", /needsReview/],
  ["src/app/api/admin/tasting-notes/promote/route.ts", /needsReview/],
  ["src/app/api/admin/tasting-notes/split/route.ts", /needsReview/],
];

test("每个茶品读点/写点都碰到了 needsReview", () => {
  for (const [file, pattern] of READ_POINTS) {
    const src = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.match(src, pattern, `${file} 没有处理 needsReview`);
  }
});

test("待整理的茶品不会被公开读点放行（写死的 needsReview: false 只能是「排除」）", () => {
  // 公开读点里不能出现「只按 isClassic 过滤、忘了 needsReview」的情况。
  // 下面两个文件是公开的：它们的过滤必须包含 needsReview。
  for (const file of [
    "src/app/api/teas/route.ts",
    "src/app/(main)/tea/page.tsx",
  ]) {
    const src = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.match(src, /visibleTeaWhere/, `${file} 应当调 visibleTeaWhere（唯一口径）`);
  }
});
