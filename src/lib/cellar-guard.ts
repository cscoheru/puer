/**
 * 茶仓访问判定的**纯逻辑**（PRD v0.3 §5 Phase 2）。
 *
 * ## 为什么要从 route 里抽出来
 *
 * 七个接口的每一个授权决定都走 `resolveCellarActor`。那个文件 import 了
 * `next/server` 和 `@/lib/auth` —— 裸 `node --test` 解析不了这两个（没有
 * tsx loader，也没有 `imports` 映射），所以**判定逻辑一行都测不了**。
 *
 * 而这个判定守的是全站最硬的一条线：用户的茶仓是私有数据，代录写的是
 * **别人的**私有数据。判定本身必须是可测的纯函数 —— 把 Next.js 的
 * 管道部分（取 session、造响应）留在外面，判定留在这里。
 *
 * 三种结果，三种语义（不要混）：
 *   - 401：没登录。
 *   - 403：登录了但没这个权限（合成账号、普通人代录别人）。
 *   - 通过：ownerId 是数据归属的人，isProxy 说明这是不是代录。
 */

export interface CellarActorInput {
  id: string;
  role?: string | null;
  isSynthetic?: boolean;
}

export interface CellarAccessDecision {
  /** 条目的所有者 id（代录时是目标用户的 id）。 */
  ownerId: string;
  /** 操作者自己的 id。 */
  actorId: string;
  /** 是不是管理员代录（决定仓储评分标「站长评」还是「自评」）。 */
  isProxy: boolean;
}

export type CellarAccessResult =
  | { ok: true; access: CellarAccessDecision }
  | { ok: false; status: 401 | 403; error: string };

/**
 * 判定一次茶仓访问。
 *
 * @param sessionUser  登录用户（null = 未登录）
 * @param targetUserId 目标用户 id（只在代录时给；不给 = 操作自己）
 * @param canManage    操作者是否有 `cellar:manage` 权限
 */
export function decideCellarAccess(
  sessionUser: CellarActorInput | null | undefined,
  targetUserId: string | null | undefined,
  canManage: boolean,
): CellarAccessResult {
  if (!sessionUser) {
    return { ok: false, status: 401, error: "请先登录" };
  }

  // 合成账号不是人 —— 它们不该产生「用户的一手记录」（PRD §4 原则 5）。
  if (sessionUser.isSynthetic) {
    return {
      ok: false,
      status: 403,
      error: "合成账号不能使用茶仓功能",
    };
  }

  if (targetUserId && targetUserId !== sessionUser.id) {
    if (!canManage) {
      return { ok: false, status: 403, error: "无权访问他人的茶仓" };
    }
    return {
      ok: true,
      access: { ownerId: targetUserId, actorId: sessionUser.id, isProxy: true },
    };
  }

  // 目标是自己（哪怕显式传了自己的 id）—— 不算代录，评分来源是「自评」。
  return {
    ok: true,
    access: { ownerId: sessionUser.id, actorId: sessionUser.id, isProxy: false },
  };
}
