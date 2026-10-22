/**
 * 统一权限层（PRD v0.3 §13.4 Phase 1）。
 *
 * ## 为什么要有这一层
 *
 * 权限判定此前是散落在 20+ 个文件、约 70 处的 `role === "admin"` 二元判断。
 * 想加一档「版主」或「站长级作者」，就得逐处改，且漏一处就是越权。
 * 这一层把「谁能做什么」收拢成一张矩阵 + 一个 `can()` 判定。
 *
 * ## 角色
 *
 *   user       普通注册用户
 *   editor     站长级作者：写/改自己的品鉴笔记，其内容可作为「站长线」
 *   moderator  版主：管理被授权的版块（按 board_moderators 授权）
 *   admin      管理员：全部后台功能
 *   system     系统账号：无人登录，仅程序使用（自动发布账号等）
 *
 * 角色取值来自 `User.role`（列是自由文本，没有 CHECK 约束）。库里的存量值
 * 只有 user|admin；新增取值不需要改列定义，符合「迁移只增不删」。
 *
 * ## 纯函数
 *
 * 这个模块不 import prisma / auth —— 判定逻辑要能脱离数据库单测。调用方
 * 负责把 session 变成 actor（`actorFromSession`）。
 */

/** 角色取值。库里 `User.role` 是自由文本，判定时按「已知角色优先、其余按 user」处理。 */
export const ROLES = ["user", "editor", "moderator", "admin", "system"] as const;
export type Role = (typeof ROLES)[number];

/** 权限动作。命名约定 `资源:动作`，`own`/`any` 表示作用对象是本人还是任意。 */
export const ACTIONS = [
  // 论坛内容
  "post:create",
  "post:edit:own",
  "post:edit:any",
  "post:delete:own",
  "post:delete:any",
  "post:pin",
  "post:feature",
  "comment:create",
  "comment:edit:own",
  "comment:delete:own",
  "comment:delete:any",
  "comment:moderate",
  // 品鉴笔记（数据层）
  "tasting:write",
  "tasting:edit:any",
  "tasting:promote",
  // 茶品库
  "tea:create",
  "tea:edit",
  "tea:merge",
  "tea:promote",
  "tea:review",
  // 版块
  "board:moderate",
  "board:create",
  // 后台
  "admin:access",
  "admin:users",
  "admin:content",
  "admin:reports",
  "admin:settings",
  // 运营
  "video:download",
  "xhs:publish",
  "keyword:manage",
] as const;
export type Action = (typeof ACTIONS)[number];

const USER_ACTIONS: readonly Action[] = [
  "post:create",
  "post:edit:own",
  "post:delete:own",
  "comment:create",
  "comment:edit:own",
  "comment:delete:own",
];

const EDITOR_ACTIONS: readonly Action[] = [
  ...USER_ACTIONS,
  "tasting:write",
  "tasting:promote",
  "tea:create",
  "tea:review",
  "tea:promote",
];

const MODERATOR_ACTIONS: readonly Action[] = [
  ...USER_ACTIONS,
  "comment:moderate",
  "board:moderate",
  "tasting:edit:any",
];

const ADMIN_ACTIONS: readonly Action[] = [...ACTIONS];

const SYSTEM_ACTIONS: readonly Action[] = [
  "post:create",
  "comment:create",
];

/** 角色 → 允许的动作。admin 拥有全部动作。 */
const ROLE_MATRIX: Record<Role, readonly Action[]> = {
  user: USER_ACTIONS,
  editor: EDITOR_ACTIONS,
  moderator: MODERATOR_ACTIONS,
  admin: ADMIN_ACTIONS,
  system: SYSTEM_ACTIONS,
};

/** 把库里存的 role 字符串规整成已知角色。未知值按 user 处理（最小权限）。 */
export function normalizeRole(raw: string | null | undefined): Role {
  if (raw && (ROLES as readonly string[]).includes(raw)) return raw as Role;
  return "user";
}

/** 判定对象。 */
export interface Actor {
  id: string;
  role: string | null | undefined;
  /** 是否系统控制的合成账号（自动发布账号等）。 */
  isSynthetic?: boolean;
}

/**
 * 判定的附加上下文。
 *
 *  - `ownUserId` —— 被操作对象的作者 id，用来区分 own / any
 *  - `boardId` —— 被操作对象所属版块（版主授权按这个判）
 */
export interface PermissionContext {
  ownUserId?: string | null;
  boardId?: string | null;
  /** 该用户在哪些版块有版主授权（由调用方从 board_moderators 查）。 */
  moderatedBoardIds?: readonly string[];
}

/**
 * 核心判定：这个 actor 能不能做这个动作。
 *
 * 规则：
 *  1. admin 拥有全部动作。
 *  2. `*:own` 类动作：本人即可（`ownUserId` 等于 actor.id）。
 *  3. `*:any` 类动作：需要角色显式拥有。
 *  4. `board:moderate`：admin，或在该版块有版主授权的 moderator。
 *  5. 合成账号（isSynthetic）只保留 system 的那点能力 —— 它们不是人，
 *     不该拥有任何面向人的后台权限。
 */
export function can(
  actor: Actor | null | undefined,
  action: Action,
  ctx: PermissionContext = {},
): boolean {
  if (!actor) return false;
  const role = normalizeRole(actor.role);

  // admin 拥有一切（合成账号除外：机器人不该有后台权限）
  if (role === "admin" && !actor.isSynthetic) return true;

  // 用后缀判定，不拆分段 —— 动作名有三段（post:edit:own），拆开取中间段
  // 会永远取不到 "own"，own 类判定就整个失效了（任何人都能改别人的帖子）。
  // own 类：本人即可
  if (action.endsWith(":own")) {
    if (ctx.ownUserId && ctx.ownUserId === actor.id) {
      return ROLE_MATRIX[role].includes(action);
    }
    return false;
  }

  // 版主按版块授权
  if (action === "board:moderate") {
    if (role !== "moderator") return false;
    if (!ctx.boardId) return false;
    return (ctx.moderatedBoardIds ?? []).includes(ctx.boardId);
  }

  if (actor.isSynthetic && role !== "system") return false;

  return ROLE_MATRIX[role].includes(action);
}

/** 某角色拥有的动作列表（后台展示用）。 */
export function actionsForRole(role: string | null | undefined): readonly Action[] {
  return ROLE_MATRIX[normalizeRole(role)];
}

/** 角色的人类可读名。 */
export const ROLE_LABELS: Record<Role, string> = {
  user: "普通用户",
  editor: "站长级作者",
  moderator: "版主",
  admin: "管理员",
  system: "系统账号",
};
