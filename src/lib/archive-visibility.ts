/**
 * 转化档案（站长的品鉴记录）的**可见性分级** —— 一份实现，所有页面共用。
 *
 * ## 分档（站长 2026-11-02 定的口径）
 *
 * | 档位 | 谁能看 | 摘要 | 正文 | 图片 | 详情页 |
 * |---|---|---|---|---|---|
 * | `public` | 任何人（未登录） | 完整 | 锁 | 前 10 张 | **打不开**（跳登录） |
 * | `member` | 已登录 | 完整 | 锁 | 前 10 张 | 能打开，正文锁 |
 * | `paid`   | 付费会员 | 完整 | 全文 | 全部 | 能打开，全文 |
 * | `staff`  | 管理员 | 完整 | 全文 | 全部 | 能打开 + 可编辑 |
 *
 * **摘要公开、正文要付费会员** —— 这就是 P2-R22 当初预留付费体系时的原意
 * （「受保护内容一律不进 SSR（view-source 拿不到全文/图 URL）」）。
 *
 * 2026-11-02 第一次落地时我把 `member` 当成了「已登录 = 看全文」，等于给全体
 * 注册用户开了全文 —— 与 P2-R22 的口径矛盾。已改回：登录只解锁**详情页的进入
 * 资格**，正文仍然锁着。
 *
 * ## 为什么抽成模块
 *
 * 这套分级原先是 `src/app/(main)/tea/[id]/page.tsx` 里的三个局部变量
 * （`isPaidMember = false` 的占位、`ARCHIVE_PREVIEW_LEN = 64`、
 * `WALL_PREVIEW_COUNT = 10`），详情页要再实现一遍就必然漂 —— 而漂了不会报错，
 * 只会「某处把全文漏给了不该看的人」。AGENTS.md R28：**同一件事只有一份实现**。
 *
 * ## 「受保护内容不进 SSR」是硬要求
 *
 * 匿名访客拿到的是 RSC payload —— 如果服务端把 `content` 原样传给客户端组件，
 * view-source 里就有全文了。分级函数因此返回的是**该给的内容**，不是「能不能看」
 * 的布尔值：调用方只能把分级后的结果往下传。
 *
 * ## 付费体系
 *
 * `isPaidMember` 目前恒为 false（站内还没有付费体系）。将来接上付费时，
 * 会员拿到 `paid` 档 —— 不用改任何调用点。
 */

/** 四档。 */
export type ArchiveTier = "public" | "member" | "paid" | "staff";

export interface ArchiveViewer {
  /** 登录用户 id（未登录为 null/undefined）。 */
  userId?: string | null;
  /** 管理员。 */
  isAdmin?: boolean;
  /** 付费会员（体系未落地时恒为 false）。 */
  isPaidMember?: boolean;
}

/** 图片墙的预览张数（未付费档只给前几张，其余用锁定遮罩）。 */
export const WALL_PREVIEW_COUNT = 10;

/**
 * 算出访客的档案档位。
 *
 * `staff`（管理员）> `paid`（付费会员）> `member`（已登录）> `public`（匿名）。
 */
export function archiveTier(viewer: ArchiveViewer | null | undefined): ArchiveTier {
  if (viewer?.isAdmin) return "staff";
  if (viewer?.isPaidMember) return "paid";
  if (viewer?.userId) return "member";
  return "public";
}

/** 能不能看完整正文？（付费会员与管理员） */
export function canViewArchiveBody(tier: ArchiveTier): boolean {
  return tier === "paid" || tier === "staff";
}

/** 能不能看**全部**图片？（付费会员与管理员；其余只给前几张） */
export function canViewArchiveImages(tier: ArchiveTier): boolean {
  return tier === "paid" || tier === "staff";
}

/** 能不能编辑这条笔记？ */
export function canEditArchive(tier: ArchiveTier): boolean {
  return tier === "staff";
}

/**
 * 能不能**打开详情页**？
 *
 * 匿名访客不能打开（2026-11-02 站长定的口径：「非登录状态无法点击，
 * 用户点击则提示登录」）—— 列表上的卡片对他们不是链接。
 */
export function canOpenArchiveDetail(tier: ArchiveTier): boolean {
  return tier !== "public";
}

/**
 * 档案内容按档位裁剪 —— **服务端必须用这个结果去裁**，不能另写一份判断。
 *
 * @param tier    访客档位
 * @param content 笔记正文
 * @param images  笔记图片
 */
export function gateArchiveContent(
  tier: ArchiveTier,
  content: string,
  images: string[],
): { content: string; images: string[]; locked: boolean } {
  if (canViewArchiveBody(tier)) {
    return { content, images, locked: false };
  }
  // 未付费：正文不给；图片只给前 WALL_PREVIEW_COUNT 张（其余的 URL 不下发）
  return {
    content: "",
    images: images.slice(0, WALL_PREVIEW_COUNT),
    locked: true,
  };
}

/** 访客能不能看某条笔记的完整正文（作者本人永远可以）。 */
export function canViewNoteBody(
  tier: ArchiveTier,
  viewer: ArchiveViewer | null | undefined,
  noteAuthorId: string | null | undefined,
): boolean {
  if (canViewArchiveBody(tier)) return true;
  // 作者本人永远看得到自己的笔记
  return !!viewer?.userId && !!noteAuthorId && viewer.userId === noteAuthorId;
}
