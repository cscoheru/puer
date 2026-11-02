/**
 * 「谁能管茶品」的判定 —— 管理员与站长。
 *
 * ## 为什么单独一个模块
 *
 * 2026-11-02 站长要求：「关于发布新经典，只有 admin 和站长用户可以，其他用户不能
 * 发布新经典（看不到这个按钮）更不能编辑茶品。」
 *
 * 查实当时的闸门**完全绕开了权限层**：`POST /api/teas` 与 `PUT /api/teas/[id]`
 * 都只判 `session.user.level >= 2`（等级闸门）—— 任何 Lv.2 普通用户可以创建茶品、
 * 直接把 `isClassic` 设成 true、并且编辑**任意一款**经典茶的名称/年份/封面/行情。
 * 这是真的越权，不是「设计上开放给爱茶人」。
 *
 * ## 「站长」按 PRD 自己的口径认
 *
 * PRD v0.3 §12 决策 2：「本文所有『role=editor / 站长线』一律理解为 authorId 属于
 * 配置中的站长账号列表，不硬编码」。所以这里的「站长」= **uid ∈ EDITOR_AUTHOR_UIDS**
 * （`src/lib/editor-line.ts::editorAuthorUids`，env 可覆盖，默认 1001/1002）——
 * 与站长线取数用的是**同一份**名单（改了它，站长线与建茶权限一起变，不会分叉）。
 *
 * 「管理员」= 权限层里的 `admin` 角色（`can(actor, "tea:edit")`；admin 拥有全部动作，
 * `editor` 角色在本次改造后也补上了 `tea:edit`）。
 *
 * ## 合成账号
 *
 * `isSynthetic` 的账号一律不算数 —— 机器人不该有「管茶品」的权限，哪怕它的 uid
 * 碰巧在白名单里（白名单是人写的，不该被自动注册的机器号继承）。
 */
import { can, type Actor } from "./permissions.ts";
import { editorAuthorUids } from "./editor-line.ts";

/** 判定用的身份：权限层的 Actor + uid（白名单要用）。 */
export interface TeaManagerActor extends Actor {
  uid?: number | null;
}

/**
 * 这个人能不能新建经典 / 编辑茶品？
 *
 * @param actor 当前用户（未登录传 null）
 * @param env   环境变量（测试里可注入）
 */
export function canManageTeas(
  actor: TeaManagerActor | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!actor) return false;
  // 合成账号（自动发布号等）没有任何后台权限 —— 白名单也不例外
  if (actor.isSynthetic) return false;
  // 管理员 + editor 角色（走权限层，将来加角色只改矩阵）
  if (can(actor, "tea:edit")) return true;
  // 站长：uid 白名单（与站长线取数同一份名单）
  const uid = actor.uid;
  if (typeof uid !== "number") return false;
  return editorAuthorUids(env).includes(uid);
}

/**
 * 能不能**发布新经典**（把茶品提升为经典）。
 *
 * 与 `canManageTeas` 分开是因为这是一件更窄的事：站长能改自己认可的茶，
 * 但「把它选进经典普洱吧」是策展动作 —— 只给管理员与站长。
 */
export function canPromoteToClassic(
  actor: TeaManagerActor | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!actor) return false;
  if (actor.isSynthetic) return false;
  if (can(actor, "tea:promote")) return true;
  const uid = actor.uid;
  if (typeof uid !== "number") return false;
  return editorAuthorUids(env).includes(uid);
}
