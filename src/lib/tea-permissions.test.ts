/**
 * 「谁能管茶品」的判定 —— 钉住 2026-11-02 那次越权修复。
 *
 * 事故形态：`POST /api/teas` 与 `PUT /api/teas/[id]` 的闸门只判 `level >= 2`，
 * 任何 Lv.2 普通用户能建茶品、能直接把它设成经典、能改任意一款经典茶。
 * 这些断言的作用是：**谁再把闸门换回等级判定，这里会红。**
 *
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { canManageTeas, canPromoteToClassic } from "./tea-permissions.ts";

const admin = { id: "u-admin", role: "admin", uid: 1003 };
const editor = { id: "u-editor", role: "editor", uid: 2001 };
const ordinary = { id: "u-ordinary", role: "user", uid: 3001, level: 4 };
const ownerByUid = { id: "u-owner", role: "user", uid: 1001 };

test("管理员能管茶品", () => {
  assert.equal(canManageTeas(admin), true);
  assert.equal(canPromoteToClassic(admin), true);
});

test("站长级作者（editor 角色）能管茶品", () => {
  assert.equal(canManageTeas(editor), true);
  assert.equal(canPromoteToClassic(editor), true);
});

test("站长（uid 白名单，与站长线同一份名单）能管茶品", () => {
  // uid 1001 = 渔夫，role 是 user —— 「站长」不靠 role，靠名单
  assert.equal(canManageTeas(ownerByUid), true);
});

test("普通用户不能管茶品（哪怕等级很高）", () => {
  assert.equal(canManageTeas(ordinary), false);
  assert.equal(canPromoteToClassic(ordinary), false);
});

test("未登录 / 空 actor 一律拒绝", () => {
  assert.equal(canManageTeas(null), false);
  assert.equal(canManageTeas(undefined), false);
  assert.equal(canManageTeas({ id: "x", role: "user" }), false); // 没有 uid
});

test("合成账号没有后台权限（哪怕 uid 在白名单里）", () => {
  assert.equal(
    canManageTeas({ id: "bot", role: "user", uid: 1001, isSynthetic: true }),
    false,
  );
  assert.equal(
    canManageTeas({ id: "bot", role: "admin", uid: 1001, isSynthetic: true }),
    false,
  );
});

test("白名单可以用 env 覆盖（与站长线取数同一份名单）", () => {
  const env = { EDITOR_AUTHOR_UIDS: "1001,1003" };
  assert.equal(canManageTeas({ id: "x", role: "user", uid: 1003 }, env), true);
  assert.equal(canManageTeas({ id: "x", role: "user", uid: 1002 }, env), false);
});

test("白名单写坏时回落默认值（不放行陌生人）", () => {
  const env = { EDITOR_AUTHOR_UIDS: "abc,," };
  assert.equal(canManageTeas({ id: "x", role: "user", uid: 1001 }, env), true);
  assert.equal(canManageTeas({ id: "x", role: "user", uid: 9999 }, env), false);
});

test("未知角色按最小权限处理", () => {
  assert.equal(canManageTeas({ id: "x", role: "adminn", uid: 9999 }), false);
});
