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
