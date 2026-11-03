/**
 * 茶品库的**三层**（PRD v0.3 §5 Phase 3 的「经典 / 普通 / 待整理」）。
 *
 * ## 为什么分三层
 *
 * 站长 2026-10-24 提的：搜「国饮」出来「国饮-2015班章大树」「普洱自在饮：
 * 2019-01茶友盲品」「国饮-2015」等一堆重复条目 —— 同一款茶被反复导入，
 * 名字随意，站长没时间手工合并清理，但**用户搜到的结果不能有重复**。
 *
 * 于是把「谁能看见」拆成三层：
 *
 *   | 层 | 判定 | 谁能看见 |
 *   |---|---|---|
 *   | 经典 | `isClassic = true` | 所有人 |
 *   | 普通 | `isClassic = false` 且 `needsReview = false` | 所有人 |
 *   | 待整理 | `needsReview = true` | 站长 + 创建者本人 |
 *
 * 「待整理」是**茶品素材**：来自用户笔记导入后的提炼、用户自建、或
 * 存量重复条目 —— 等站长编辑过（改名、合并、或提升为经典）才进入
 * 前两层。
 *
 * ## 为什么用布尔位而不是枚举
 *
 * `isClassic` 已经是布尔位且全套功能（经典区、SEO、落地页）都在用它。
 * 再加一个布尔位就够了 —— 枚举意味着要改所有读点的取值判断，
 * 而「经典」这一层的语义根本不会变。
 *
 * ## 一条规则一处实现
 *
 * 读点**不许**各自写 `needsReview: false` —— 口径要漂移的。统一调
 * `visibleTeaWhere()`，它就是那一份。
 */

/** 茶品的三层。 */
export type TeaTier = "classic" | "regular" | "pending";

/** 判定一层 —— 判断依据只有两个布尔位。 */
export function teaTier(tea: {
  isClassic: boolean;
  needsReview: boolean;
}): TeaTier {
  if (tea.isClassic) return "classic";
  if (tea.needsReview) return "pending";
  return "regular";
}

/** 层的显示名（后台用）。 */
export const TEA_TIER_LABELS: Record<TeaTier, string> = {
  classic: "经典",
  regular: "普通",
  pending: "待整理",
};

/** 看茶品的人。 */
import { canManageTeas } from "./tea-permissions.ts";

export interface TeaViewer {
  /** 登录用户的 id（未登录为 null）。 */
  id: string | null;
  /** 是不是管理员（站长）。 */
  isAdmin: boolean;
}

/**
 * **公开目录**里看得见的茶品（Prisma where 片段）。
 *
 * 「待整理」对**所有人**隐藏 —— 包括管理员自己。
 *
 * ⚠️ 为什么管理员也看不见：站长 2026-10-24 报的「搜出来一堆重复」是**他
 * 自己在公开页上搜的**。如果管理员在公开页仍能搜到待整理的条目，那条
 * 抱怨在他自己的视角里就一天都没解决。整理队列在后台（`/admin/teas`
 * 的「只看待整理」），那里本来就该看到全部。
 *
 * 详情页是另一回事：直链进去时，创建者本人与站长仍然看得到（见
 * `canViewPendingTea`）—— 那是「我刚建的那条，让我看一眼」，不是
 * 「公开目录里混着重复条目」。
 *
 * ⚠️ 这是**唯一**一份公开可见性口径。读点调它，别自己写
 * `needsReview: false` —— 漏一个就是「待整理的茶品从某个缝里漏出去了」。
 */
export function visibleTeaWhere(): Record<string, unknown> {
  return { needsReview: false };
}

/** 「我的目录」里看得见的茶品（**登录后**的列表与搜索）。 */
export interface TeaDirectoryViewer {
  id: string | null;
  /** 是不是管理员（session 上没有这个字段时按 role 判断，故可选）。 */
  isAdmin?: boolean;
  role?: string | null;
  uid?: number | null;
  isSynthetic?: boolean;
}

/**
 * 「我的目录」可见性 —— 管理员与站长能看到**待整理**的条目。
 *
 * 与 `visibleTeaWhere()` 的差别只有一处：待整理的茶品对**管理员与站长**不再
 * 隐藏（他们能在茶品库里搜到自己刚建的条目）。普通用户与匿名仍然只看已整理的。
 *
 * ## 为什么改了这条（2026-11-02）
 *
 * 2026-10-24 「待整理对所有人隐藏（含管理员）」是为了解决「搜出来一堆重复」——
 * 当时**任何 Lv.2 用户**都能建茶，重复条目来自用户。
 *
 * 2026-11-02 起创建口关给管理员与站长（`canManageTeas`），重复只可能来自他们
 * 自己；「待整理」于是变成**他们的工作台**而不是垃圾堆。于是出现了一个荒谬的
 * 局面：管理员在茶品库里新建一条茶品 → 保存后跳到详情页（`canViewPendingTea`
 * 放行）→ 回到茶品库**搜不到自己刚建的茶**。
 *
 * 公开面不受影响：普通用户与匿名的列表/搜索仍走 `visibleTeaWhere()`。
 */
export function visibleTeaWhereForViewer(
  viewer: TeaDirectoryViewer | null | undefined,
): Record<string, unknown> {
  if (!viewer?.id) return visibleTeaWhere();
  if (canManageTeas({ ...viewer, id: viewer.id, role: viewer.role ?? null })) return {};
  return visibleTeaWhere();
}

/**
 * 详情页的可见性：待整理的条目，创建者本人与站长看得到。
 */
export function canViewPendingTea(
  tea: { createdBy: string; isClassic: boolean; needsReview: boolean },
  viewer: TeaViewer | null,
): boolean {
  if (!tea.needsReview) return true;
  if (!viewer) return false;
  if (viewer.isAdmin) return true;
  return tea.createdBy === viewer.id;
}

/**
 * 「待整理」这一层**只有站长看得到**的 where 片段。
 *
 * 与 `visibleTeaWhere` 的区别：这里连「自己建的」都不给 ——
 * 用于后台的审核队列（要处理的是**全部**待整理条目，不是自己的）。
 */
export const PENDING_TEA_WHERE = { needsReview: true } as const;
