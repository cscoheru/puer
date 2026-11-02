/**
 * 转化档案（站长的品鉴记录）的**可见性分级** —— 一份实现，两处页面共用。
 *
 * ## 口径（站长 2026-11-02 定）
 *
 *   摘要公开 —— 任何访客都能看到完整摘要、评分、冲泡参数
 *   正文要登录 —— 完整笔记正文与全部图片，登录后可见
 *   可编辑    —— 仅管理员
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
 * 匿名访客拿到的是 RSC payload —— 如果服务端把 `content` / `images` 原样传给
 * 客户端组件，view-source 里就有全文了。分级函数因此返回的是**该给的内容**，
 * 不是「能不能看」的布尔值：调用方只能把分级后的结果往下传。
 *
 * ## 付费体系
 *
 * `isPaidMember` 目前恒为 false（站内还没有付费体系）。将来接上付费时，把
 * 「member」这一档从「已登录」改成「已登录或付费会员」即可 —— 只有这一行。
 */

/** 三档。 */
export type ArchiveTier = "public" | "member" | "staff";

export interface ArchiveViewer {
  /** 登录用户 id（未登录为 null/undefined）。 */
  userId?: string | null;
  /** 管理员。 */
  isAdmin?: boolean;
  /** 付费会员（体系未落地时恒为 false）。 */
  isPaidMember?: boolean;
}

/** 图片墙的预览张数（匿名访客只给前几张，其余用锁定遮罩）。 */
export const WALL_PREVIEW_COUNT = 10;

/**
 * 算出访客的档案档位。
 *
 * `staff`（管理员）> `member`（登录 / 付费会员）> `public`（匿名）。
 */
export function archiveTier(viewer: ArchiveViewer | null | undefined): ArchiveTier {
  if (viewer?.isAdmin) return "staff";
  if (viewer?.isPaidMember) return "member";
  if (viewer?.userId) return "member";
  return "public";
}

/** 能不能看完整正文？ */
export function canViewArchiveBody(tier: ArchiveTier): boolean {
  return tier === "member" || tier === "staff";
}

/** 能不能看全部笔记图片？ */
export function canViewArchiveImages(tier: ArchiveTier): boolean {
  return tier === "member" || tier === "staff";
}

/** 能不能编辑这条笔记？ */
export function canEditArchive(tier: ArchiveTier): boolean {
  return tier === "staff";
}

/**
 * 档案内容按档位裁剪 —— **服务端必须用这个结果去裁**，不能另写一份判断。
 *
 * @param tier   访客档位
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
  // 匿名：正文不给；图片只给前 WALL_PREVIEW_COUNT 张（其余的 URL 不下发）
  return {
    content: "",
    images: images.slice(0, WALL_PREVIEW_COUNT),
    locked: true,
  };
}

/** 访客能不能看某条笔记的完整正文（按 note 的作者是不是自己再判一次）。 */
export function canViewNoteBody(
  tier: ArchiveTier,
  viewer: ArchiveViewer | null | undefined,
  noteAuthorId: string | null | undefined,
): boolean {
  if (canViewArchiveBody(tier)) return true;
  // 作者本人永远看得到自己的笔记
  return !!viewer?.userId && !!noteAuthorId && viewer.userId === noteAuthorId;
}
