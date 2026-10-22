import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { can, type Action, type PermissionContext } from "@/lib/permissions";

/**
 * 后台访问的判定入口（PRD v0.3 §13）。
 *
 * 这里以前是 `session.user.role !== "admin"` 一句判死。现在走统一权限层：
 * 新增角色时改 `src/lib/permissions.ts` 的矩阵即可，不必逐个路由改。
 *
 * 名字 `requireAdmin` 保留了下来 —— 20+ 个后台路由都 import 它，改名要一次
 * 动一大片。语义上它现在表示「有后台访问权」，与 admin 角色不完全等价
 * （将来版主也可访问部分后台）。
 */
export async function requireAdmin() {
  const session = await auth();
  if (!session?.user || !can(session.user, "admin:access")) {
    return {
      session: null,
      error: NextResponse.json({ error: "仅管理员可操作" }, { status: 403 }),
    };
  }
  return { session, error: null };
}

/**
 * 按具体动作判定（PRD v0.3 §13）。新代码用它代替散落的 `role === "admin"`。
 *
 * @param action 权限动作，见 src/lib/permissions.ts 的 ACTIONS
 * @param ctx    判定上下文（归属作者 id、版块 id 等）
 */
export async function requirePermission(
  action: Action,
  ctx: PermissionContext = {},
) {
  const session = await auth();
  if (!session?.user || !can(session.user, action, ctx)) {
    return {
      session: null,
      error: NextResponse.json({ error: "无权执行此操作" }, { status: 403 }),
    };
  }
  return { session, error: null };
}
