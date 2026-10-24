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
 * **看得见的茶品**的 where 片段（Prisma）。
 *
 * - 管理员 → 全部可见（含待整理，那是他的工作台）
 * - 登录用户 → 经典 + 普通 + **自己建的待整理条目**
 *   （用户刚建的那条不能连自己都看不到，但也不该在整理之前就公开）
 * - 匿名 → 只有经典
 *
 * ⚠️ 这是**唯一**一份可见性口径。读点调它，别自己写 `needsReview: false` ——
 * 漏一个就是「待整理的茶品从某个缝里漏出去了」。
 */
export function visibleTeaWhere(viewer: TeaViewer): Record<string, unknown> {
  if (viewer.isAdmin) return {};
  if (!viewer.id) return { needsReview: false };
  return {
    OR: [
      { needsReview: false },
      // 自己建的待整理条目：自己看得见，别人看不见
      { needsReview: true, createdBy: viewer.id },
    ],
  };
}

/**
 * 「待整理」这一层**只有站长看得到**的 where 片段。
 *
 * 与 `visibleTeaWhere` 的区别：这里连「自己建的」都不给 ——
 * 用于后台的审核队列（要处理的是**全部**待整理条目，不是自己的）。
 */
export const PENDING_TEA_WHERE = { needsReview: true } as const;
