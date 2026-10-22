import { test } from "node:test";
import assert from "node:assert/strict";
import {
  can,
  normalizeRole,
  actionsForRole,
  ROLE_LABELS,
  ROLES,
  type Actor,
} from "./permissions.ts";

const user: Actor = { id: "u1", role: "user" };
const editor: Actor = { id: "e1", role: "editor" };
const moderator: Actor = { id: "m1", role: "moderator" };
const admin: Actor = { id: "a1", role: "admin" };
const system: Actor = { id: "s1", role: "system" };
const bot: Actor = { id: "b1", role: "admin", isSynthetic: true };

test("未知角色按最小权限（user）处理", () => {
  assert.equal(normalizeRole("wat"), "user");
  assert.equal(normalizeRole(null), "user");
  assert.equal(normalizeRole(""), "user");
  assert.equal(normalizeRole("admin"), "admin");
  assert.equal(can({ id: "x", role: "wat" }, "post:create"), true);
  assert.equal(can({ id: "x", role: "wat" }, "admin:access"), false);
});

test("普通用户：能发/评，不能进后台、不能改别人的东西", () => {
  assert.equal(can(user, "post:create"), true);
  assert.equal(can(user, "comment:create"), true);
  assert.equal(can(user, "admin:access"), false);
  assert.equal(can(user, "post:edit:any"), false);
  assert.equal(can(user, "tea:create"), false);
});

test("own 类动作只在作用于自己时放行", () => {
  assert.equal(can(user, "post:edit:own", { ownUserId: "u1" }), true);
  assert.equal(can(user, "post:edit:own", { ownUserId: "other" }), false);
  assert.equal(can(user, "post:edit:own", {}), false, "没有归属信息时不得放行");
  assert.equal(can(user, "post:delete:own", { ownUserId: "u1" }), true);
  // 别人的帖：own 不通，any 也不通
  assert.equal(can(user, "post:edit:any", { ownUserId: "other" }), false);
});

test("站长级作者：能写品鉴、录茶品，但不能进后台", () => {
  assert.equal(can(editor, "tasting:write"), true);
  assert.equal(can(editor, "tea:create"), true);
  assert.equal(can(editor, "tea:review"), true);
  assert.equal(can(editor, "admin:access"), false);
});

test("版主：能管评论与被授权的版块", () => {
  assert.equal(can(moderator, "comment:moderate"), true);
  assert.equal(can(moderator, "board:moderate", { boardId: "b1", moderatedBoardIds: ["b1"] }), true);
  assert.equal(can(moderator, "board:moderate", { boardId: "b2", moderatedBoardIds: ["b1"] }), false);
  assert.equal(can(moderator, "board:moderate", { boardId: "b1" }), false, "没有授权列表时不得放行");
  assert.equal(can(moderator, "admin:access"), false);
});

test("管理员：全部动作，但合成账号除外", () => {
  assert.equal(can(admin, "admin:access"), true);
  assert.equal(can(admin, "post:edit:any"), true);
  assert.equal(can(admin, "tea:merge"), true);
  assert.equal(can(admin, "xhs:publish"), true);
  // 机器人即使挂着 admin 也不该有后台权限
  assert.equal(can(bot, "admin:access"), false);
  assert.equal(can(bot, "post:edit:any"), false);
});

test("系统账号：只能程序化发帖与评论，没有后台权限", () => {
  assert.equal(can(system, "post:create"), true);
  assert.equal(can(system, "comment:create"), true);
  assert.equal(can(system, "admin:access"), false);
  assert.equal(can(system, "post:edit:any"), false);
});

test("空 actor 一律拒绝", () => {
  assert.equal(can(null, "post:create"), false);
  assert.equal(can(undefined, "post:create"), false);
});

test("admin 拥有全部动作（矩阵完备性）", () => {
  const all = actionsForRole("admin");
  for (const role of ROLES) {
    // admin 的能力集必须覆盖其它角色的全部能力
    for (const a of actionsForRole(role)) {
      assert.ok(all.includes(a), `admin 应包含 ${role} 的 ${a}`);
    }
  }
});

test("角色标签齐全", () => {
  for (const role of ROLES) {
    assert.ok(ROLE_LABELS[role], `${role} 缺标签`);
  }
});
