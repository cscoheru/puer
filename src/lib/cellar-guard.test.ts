import { test } from "node:test";
import assert from "node:assert/strict";

import { decideCellarAccess } from "./cellar-guard.ts";

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
