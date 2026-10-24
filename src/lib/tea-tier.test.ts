import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { TEA_TIER_LABELS, canViewPendingTea, teaTier, visibleTeaWhere } from "./tea-tier.ts";

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

// ─── 公开目录的可见性（只有一份）─────────────────────────────────────────

test("公开目录对所有人隐藏「待整理」—— 包括管理员自己", () => {
  // 站长 2026-10-24 报的「搜出来一堆重复」是**他自己在公开页上搜的**。
  // 管理员在公开页仍能搜到待整理条目的话，那条抱怨在他视角里就没解决。
  assert.deepEqual(visibleTeaWhere(), { needsReview: false });
});

// ─── 详情页的可见性（直链）───────────────────────────────────────────────

test("详情页：普通条目谁都能看", () => {
  assert.equal(
    canViewPendingTea({ createdBy: "u1", isClassic: false, needsReview: false }, null),
    true,
  );
});

test("详情页：待整理的条目，站长与创建者看得到", () => {
  const tea = { createdBy: "u1", isClassic: false, needsReview: true };
  assert.equal(canViewPendingTea(tea, { id: "admin", isAdmin: true }), true);
  assert.equal(canViewPendingTea(tea, { id: "u1", isAdmin: false }), true);
});

test("详情页：待整理的条目，别人看不到", () => {
  const tea = { createdBy: "u1", isClassic: false, needsReview: true };
  assert.equal(canViewPendingTea(tea, { id: "u2", isAdmin: false }), false);
  assert.equal(canViewPendingTea(tea, null), false);
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
  ["src/app/api/teas/[id]/route.ts", /canViewPendingTea|needsReview/],
  ["src/app/(main)/tea/page.tsx", /visibleTeaWhere|needsReview/],
  ["src/app/(main)/tea/[id]/page.tsx", /canViewPendingTea|needsReview/],
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
