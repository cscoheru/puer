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
 *
 * ## 可见性判定也在这个文件里
 *
 * 「能不能看见茶仓这个功能」与「能不能操作某条条目」是两件事：
 *   - 可见性 → 不可见回 **404**（功能不存在，不泄露它的存在）
 *   - 操作权 → 401 / 403（详见上面）
 *
 * 可见性判定的规则（2026-10-23 站长拍板：只按 uid 白名单，不看 role）：
 *
 *   FEATURE_CELLAR=1            → 全体可见（正式发布时的全局开关）
 *   否则                          → uid ∈ (EDITOR_AUTHOR_UIDS ∪ CELLAR_UIDS)
 *
 * 两个 import 都用相对路径 —— 这个文件要被裸 `node --test` 跑（npm run
 * test:unit 不带 tsx），`@/` 别名在那里解析不了。
 */
import { isFeatureEnabled } from "./feature-flags.ts";
import { editorAuthorUids, parseUidList } from "./editor-line.ts";

export interface CellarActorInput {
  id: string;
  isSynthetic?: boolean;
}

/** 可见性判定只需要 uid —— 不看 role。 */
export interface CellarUserInput {
  uid?: number | null;
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

/**
 * 茶仓可见人群（uid 白名单）。
 *
 * = 站长线作者白名单 ∪ 茶仓白名单。
 *
 * 两个名单都表达「这个人是站内的自己人」，取并集而不是二选一：
 *   - `EDITOR_AUTHOR_UIDS` 是既有的站长线作者名单（容器里没注入时用代码默认
 *     `[1001, 1002]`）；
 *   - `CELLAR_UIDS` 是本次新增的，用来点名「开给内测的种子用户」。
 *
 * 站长线的作者天然是站长，所以默认就该能进茶仓；反过来，想让某个人
 * 只进茶仓不进站长线，就写 `CELLAR_UIDS`。
 *
 * 两个名单用同一份解析（`parseUidList`，在 editor-line.ts 里）—— 白名单
 * 的容错口径一旦分叉，就会出现「站长线认得、茶仓不认」这种查不出来的错。
 */
export function cellarUidAllowlist(
  env: Record<string, string | undefined> = process.env,
): number[] {
  const ids = new Set<number>();
  for (const id of editorAuthorUids(env)) ids.add(id);
  for (const id of parseUidList(env.CELLAR_UIDS)) ids.add(id);
  return [...ids].sort((a, b) => a - b);
}

/**
 * 这个账号能不能看见/使用茶仓。
 *
 * 规则见文件头：全局 flag 开着 → 所有人；否则按 uid 白名单。
 *
 * 「看不见」与「没有权限」是两件事，这里只回答前者（404 的那一层）；
 * 登录态、合成账号、代录权限由 `decideCellarAccess` 回答（401/403）。
 */
export function cellarVisibleTo(
  user: CellarUserInput | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (isFeatureEnabled("cellar", env)) return true;
  const uid = user?.uid;
  if (typeof uid !== "number") return false;
  return cellarUidAllowlist(env).includes(uid);
}
