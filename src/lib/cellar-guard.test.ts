import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cellarUidAllowlist,
  cellarVisibleTo,
  decideCellarAccess,
} from "./cellar-guard.ts";
import { FEATURE_FLAGS } from "./feature-flags.ts";

/**
 * 茶仓访问判定的单测。
 *
 * 这个判定守的是全站最硬的一条线：用户的茶仓是私有数据，代录写的是
 * **别人的**私有数据。判定抽成纯函数就是为了让它能被测住 ——
 * 判定逻辑一旦漂移，别的用户的茶仓记录就会在测试全绿的情况下漏出去。
 */

const USER = { id: "u1", role: "user", isSynthetic: false };
const ADMIN = { id: "a1", role: "admin", isSynthetic: false };

test("未登录 → 401", () => {
  const r = decideCellarAccess(null, null, false);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 401);
});

test("session 为 undefined 也算未登录", () => {
  const r = decideCellarAccess(undefined, null, false);
  assert.equal(r.ok === false && r.status, 401);
});

test("合成账号 → 403（不是人，不该产生一手记录）", () => {
  const r = decideCellarAccess(
    { ...USER, isSynthetic: true },
    null,
    false,
  );
  assert.equal(r.ok === false && r.status, 403);
});

test("合成账号即使有 cellar:manage 也拦下", () => {
  const r = decideCellarAccess(
    { ...ADMIN, isSynthetic: true },
    null,
    true,
  );
  assert.equal(r.ok === false && r.status, 403);
});

test("操作自己 → 通过，ownerId 是自己，不是代录", () => {
  const r = decideCellarAccess(USER, null, false);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok === true && r.access, {
    ownerId: "u1",
    actorId: "u1",
    isProxy: false,
  });
});

test("显式传自己的 id 也算操作自己（不是代录）", () => {
  const r = decideCellarAccess(USER, "u1", true);
  assert.equal(r.ok, true);
  assert.equal(r.ok === true && r.access.isProxy, false);
  assert.equal(r.ok === true && r.access.ownerId, "u1");
});

test("普通人代录别人 → 403", () => {
  const r = decideCellarAccess(USER, "u2", false);
  assert.equal(r.ok === false && r.status, 403);
  assert.match(r.ok === false ? r.error : "", /无权访问/);
});

test("有 cellar:manage 代录别人 → ownerId 是目标用户，isProxy=true", () => {
  const r = decideCellarAccess(ADMIN, "u2", true);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok === true && r.access, {
    ownerId: "u2",
    actorId: "a1",
    isProxy: true,
  });
});

test("代录时 ownerId 一定是目标用户，绝不会回落到操作者", () => {
  const r = decideCellarAccess(ADMIN, "u2", true);
  assert.equal(r.ok === true && r.access.ownerId, "u2");
  assert.notEqual(r.ok === true && r.access.ownerId, "a1");
});

// ── 可见性判定（2026-10-23 起：先只对站长开放）────────────────────────

/** flag 关着 —— 这是现在的生产状态（FEATURE_CELLAR=0）。 */
const OFF = { FEATURE_CELLAR: "0" };

test("全局 flag 开着 → 名单外的人也可见（正式发布时的总闸）", () => {
  const env = { FEATURE_CELLAR: "1" };
  assert.equal(cellarVisibleTo({ uid: 1001 }, env), true);
  assert.equal(cellarVisibleTo({ uid: 9999 }, env), true);
});

test("flag 关着 → 只有站长线作者白名单里的 uid 可见", () => {
  assert.equal(cellarVisibleTo({ uid: 1001 }, OFF), true);
  assert.equal(cellarVisibleTo({ uid: 1002 }, OFF), true);
  // 1003 是站长的第三个终端，但不在默认白名单里 —— 要进得来得点名。
  assert.equal(cellarVisibleTo({ uid: 1003 }, OFF), false);
});

test("flag 关着 → 名单外的普通用户看不见", () => {
  assert.equal(cellarVisibleTo({ uid: 2001 }, OFF), false);
  assert.equal(cellarVisibleTo({ uid: 9999 }, OFF), false);
});

test("CELLAR_UIDS 点名的人可见（内测种子用户的口子）", () => {
  const env = { ...OFF, CELLAR_UIDS: "1001,1002,1003,2001" };
  assert.equal(cellarVisibleTo({ uid: 1003 }, env), true);
  assert.equal(cellarVisibleTo({ uid: 2001 }, env), true);
  assert.equal(cellarVisibleTo({ uid: 9999 }, env), false);
});

test("CELLAR_UIDS 与站长线作者名单取并集", () => {
  const env = { ...OFF, EDITOR_AUTHOR_UIDS: "1001", CELLAR_UIDS: "1003" };
  assert.deepEqual(cellarUidAllowlist(env), [1001, 1003]);
});

test("名单解析容忍空格与重复项", () => {
  const env = { ...OFF, CELLAR_UIDS: " 1001 , 1002 ,1001 " };
  assert.deepEqual(cellarUidAllowlist(env), [1001, 1002]);
});

test("CELLAR_UIDS 写坏 → 回落到站长线作者名单，不放行任何陌生人", () => {
  const env = { ...OFF, CELLAR_UIDS: "abc" };
  assert.deepEqual(cellarUidAllowlist(env), [1001, 1002]);
  assert.equal(cellarVisibleTo({ uid: 1001 }, env), true);
  assert.equal(cellarVisibleTo({ uid: 9999 }, env), false);
});

test("CELLAR_UIDS 写坏一半 → 丢掉坏的那项，其余照用", () => {
  const env = { ...OFF, CELLAR_UIDS: "abc,2001" };
  assert.equal(cellarVisibleTo({ uid: 2001 }, env), true);
  assert.equal(cellarVisibleTo({ uid: 9999 }, env), false);
});

test("没有 uid / 未登录 → 不可见（flag 关着时）", () => {
  assert.equal(cellarVisibleTo(null, OFF), false);
  assert.equal(cellarVisibleTo(undefined, OFF), false);
  assert.equal(cellarVisibleTo({}, OFF), false);
  assert.equal(cellarVisibleTo({ uid: null }, OFF), false);
});

/**
 * 可见性判定收口在 `resolveCellarActor` 里 —— 路由自己再判一次全局 flag
 * 的话，站长会被挡住（flag 是关着的），而漏判的路由就是个没门禁的接口。
 * 这条断言把「每个茶仓接口都走守卫」钉住。
 */
function cellarRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cellarRouteFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

test("每个茶仓接口都真的调守卫、并在守卫出错时立刻返回", () => {
  const dir = fileURLToPath(new URL("../app/api/cellar/", import.meta.url));
  const files = cellarRouteFiles(dir);
  assert.ok(files.length >= 9, `茶仓路由没找全（只找到 ${files.length} 个）`);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    // 必须**真的调用**（带 await）：光有 import 名字不算数 ——
    // 「import 了但没调」或「调了但把 error 丢掉」都能让旧断言照样绿。
    assert.match(
      src,
      /await\s+resolveCellarActor\(/,
      `${f} 没真的调用 resolveCellarActor（只 import 不算）`,
    );
    // 必须真的短路：守卫出的 error 直接回响应。丢掉 error 就等于守卫没挂，
    // 私有数据会裸奔。
    assert.match(
      src,
      /if\s*\(\s*error\s*\)\s*return\s+error\s*;/,
      `${f} 没有在守卫出错时提前返回 —— 守卫等于没挂`,
    );
    // 可见性判定收口在 resolveCellarActor，路由不自己判全局 flag。
    // （旧断言查的是 /cellarEnabled/ —— 那个函数本轮已被删掉，断言变成了
    //  永远为真的死断言；真正可能出现的回归写法是 isFeatureEnabled。）
    assert.doesNotMatch(
      src,
      /isFeatureEnabled/,
      `${f} 还在自己判全局 flag —— 可见性判定会漂移`,
    );
  }
});

/** 把一个 route 文件按 handler 切开（每个 export async function 一段）。 */
function handlerBlocks(src: string): { name: string; body: string }[] {
  return src
    .split(/export\s+async\s+function\s+/)
    .slice(1)
    .map((part) => {
      const name = part.match(/^(\w+)/)?.[1] ?? "?";
      return { name, body: part };
    });
}

test("写接口里守卫排在 body 解析之前（不可见的人先拿到 404，不是 400）", () => {
  // 顺序反了的话：看不见茶仓的人会拿到 400 的参数校验错误（"要么指定茶品…"），
  // 那等于告诉他「这个接口存在、还要这些字段」—— 违背 404 的存在性语义。
  const dir = fileURLToPath(new URL("../app/api/cellar/", import.meta.url));
  for (const f of cellarRouteFiles(dir)) {
    const src = readFileSync(f, "utf8");
    for (const h of handlerBlocks(src)) {
      if (!/await readJsonBody\(|safeParse\(/.test(h.body)) continue; // GET 不受约束
      const guardAt = h.body.indexOf("await resolveCellarActor(");
      const bodyAt = h.body.search(/await readJsonBody\(|safeParse\(/);
      assert.ok(
        guardAt >= 0 && guardAt < bodyAt,
        `${f} 的 ${h.name} 里 body 解析排在守卫前面 —— ` +
          `看不见茶仓的人会拿到 400 而不是 404`,
      );
    }
  }
});

test("茶仓页面与布局按人判可见性，不按全局 flag", () => {
  // 接口层收口在 resolveCellarActor，页面/布局这一层各判一次 ——
  // 两份口径一旦漂移，就会出现「导航里没有入口、接口却能调」。
  const appDir = fileURLToPath(new URL("../app/", import.meta.url));
  const targets = [
    "(main)/tea-cellar/page.tsx",
    "(main)/tea-cellar/[id]/page.tsx",
    "(main)/layout.tsx",
    "(admin)/admin/layout.tsx",
  ];
  for (const rel of targets) {
    const src = readFileSync(join(appDir, rel), "utf8");
    assert.match(src, /cellarVisibleTo/, `${rel} 没走 cellarVisibleTo`);
    assert.doesNotMatch(
      src,
      /isFeatureEnabled\(\s*["']cellar["']\s*\)/,
      `${rel} 还在按全局 flag 判可见性 —— 与接口层的口径会漂移`,
    );
  }
});

test("茶仓是未正式发布的新功能，默认必须关", () => {
  assert.equal(FEATURE_FLAGS.cellar, false);
  // env 完全不给时（本地跑 / 没注入容器），名单外的人仍不可见
  assert.equal(cellarVisibleTo({ uid: 9999 }, {}), false);
});

test("flag 全开时未登录也算「可见」—— 这是刻意的", () => {
  // 语义分叉点，钉住它：flag 关着时未登录 → 不可见（404）；
  // flag 全开时未登录 → 可见。全局发布后功能对所有人开放，游客能看见入口，
  // 真要用（记品鉴 / 导出）时才会撞 401。钉住，免得后来者当 bug 改掉。
  assert.equal(cellarVisibleTo(null, { FEATURE_CELLAR: "1" }), true);
  assert.equal(cellarVisibleTo(null, OFF), false);
});

test("NextAuth session 带 uid —— 白名单判定靠它", () => {
  // 可见性判定吃的是 session.user.uid。哪天 uid 在 token/session 里被改名或
  // 漏写，cellarVisibleTo 会对所有人返回 false —— 茶仓对站长也 404，
  // 而单测里的 uid 都是手搓字面量，照样全绿。
  const authSrc = readFileSync(
    fileURLToPath(new URL("./auth.ts", import.meta.url)),
    "utf8",
  );
  assert.match(
    authSrc,
    /session\.user\.uid\s*=/,
    "session.user.uid 没被写入 —— 白名单判定会对所有人失效",
  );
  const typeSrc = readFileSync(
    fileURLToPath(new URL("./next-auth.d.ts", import.meta.url)),
    "utf8",
  );
  assert.match(typeSrc, /uid\?:\s*number/, "Session.user 没声明 uid");
});
