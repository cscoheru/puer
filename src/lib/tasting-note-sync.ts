/**
 * 「跟进帖 → 品鉴笔记」镜像的 **DB 层**。决策逻辑在 `tasting-note-plan.ts`（纯函数、可单测）。
 *
 * ## 关联方式：复用现有两列，不迁移 schema
 * `source = "article"` + `sourceId = article.id`。`TastingNote.sourceId` 原本是给
 * Evernote GUID 用的闲置列，语义上就是「外部来源里的 id」，正好通用。
 * 该列只有普通索引（`@@index([sourceId])`）**没有唯一约束**，所以幂等靠
 * `findFirst` 前置检查。并发重复发布理论上能产生两条，实际由「一帖一次发布请求」
 * 保证；真出现了也能靠 backfill 脚本与 `recomputeTeaStats`（按实际条数**重算**
 * 而非自增）自愈。
 *
 * ## 只在发布时建，不在归档时删
 * - 建：帖子**发布**时建。`pending_review` 不建，等审核通过路径补建 ——
 *   TastingNote 因此不需要 status 列，未审内容也不可能漏进公开的品鉴时间线。
 * - 删：只在帖子被**删除**时删。归档/翻私密/重新送审一律交给读取侧
 *   （`isMirrorNoteLive`）抑制，因为归档是可逆的，而删笔记会连带删掉
 *   `Comment.tastingNoteId` 的级联评论。
 *
 * ## 失败不抛出
 * 导出函数都**不抛异常**，只打日志。镜像笔记是发布/删除的副作用，不能因为它
 * 失败就让发帖或删帖整体失败；漏建的部分由幂等 backfill 脚本修复。但失败必须
 * 留痕（R26 复盘纪律：静默降级 = 延迟爆炸），所以走 console.error。
 */
import { prisma } from "@/lib/prisma";
import { recomputeTeaStats } from "@/lib/tea-stats";
import {
  ARTICLE_NOTE_SOURCE,
  planArticleTastingNote,
  type NoteSourceArticle,
} from "@/lib/tasting-note-plan";
import type { Prisma } from "@/generated/prisma/client";

export { ARTICLE_NOTE_SOURCE, deriveNoteSummary, isMirrorNoteLive } from "@/lib/tasting-note-plan";

/** 规划器需要的全部字段，一处定义避免两处漂移 */
export const NOTE_SOURCE_SELECT = {
  id: true,
  title: true,
  content: true,
  summary: true,
  images: true,
  videoUrl: true,
  authorId: true,
  teaId: true,
  status: true,
  visibility: true,
  origin: true,
  createdAt: true,
} satisfies Prisma.ArticleSelect;

export type SyncOutcome = "created" | "updated" | "exists" | "skipped";

/**
 * 幂等：为一条帖子**创建或更新**镜像品鉴笔记。
 *
 * 帖子在发布后仍可被编辑（`PUT /api/articles/[id]`：标题/正文/图片/视频）。
 * 镜像笔记是派生副本，源帖改了它就得跟着改，否则品鉴时间线会永远显示旧标题/旧图。
 * 所以已存在的镜像要做内容同步（createdAt 仍跟随源帖，时间线顺序不会因编辑而跳变）。
 *
 * @returns `created` 新建；`updated` 已存在并同步了内容；`exists` 已存在且无变化；
 *          `skipped` 不符合镜像条件。异常一律吞掉并记日志。
 */
export async function syncTastingNoteForArticle(articleId: string): Promise<SyncOutcome> {
  try {
    const article = await prisma.article.findUnique({
      where: { id: articleId },
      select: NOTE_SOURCE_SELECT,
    });
    if (!article) return "skipped";

    // F0：作者是否为系统控制的合成账号。规划器据此做第二道闸（与 origin
    // 标注相互独立 —— 标注可能因回填滞后而缺失，账号身份是即时可判的）。
    const author = await prisma.user.findUnique({
      where: { id: article.authorId ?? "" },
      select: { isSynthetic: true },
    });
    const authorIsSynthetic = author?.isSynthetic === true;

    // `sourceId` 只有普通索引、没有唯一约束，并发发布理论上能建出两条镜像。
    // 不用迁移加唯一索引（那要先排查存量数据是否已有重复），改成**自愈**：
    // 这里把同一 sourceId 的镜像全捞出来，保留最早的一条，多的删掉。
    // 只按 sourceId 单条件查（不与 source 组成复合 where）——@prisma/adapter-pg 7.8.0
    // 对「标量相等 + 标量 in」的复合 where 会误报 P2022 ColumnNotFound。
    const candidates = await prisma.tastingNote.findMany({
      where: { sourceId: articleId },
      select: { id: true, source: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    const mirrors = candidates.filter((n) => n.source === ARTICLE_NOTE_SOURCE);
    const existing = mirrors[0];
    const duplicates = mirrors.slice(1);
    const alreadySynced = !!existing;

    // 刻意传 alreadySynced: false：规划器在 alreadySynced=true 时会返回 skip，
    // 那样就拿不到用于更新的字段映射。是否走「更新」分支由下面 alreadySynced 决定，
    // 规划器只负责产出「这条帖子该长什么样」。
    const plan = planArticleTastingNote(
      { ...(article as NoteSourceArticle), authorIsSynthetic },
      { alreadySynced: false },
    );
    if (plan.action === "skip") {
      // F0：源帖被判为不可进数据层（AI 内容 / 合成账号 / 状态不允许）时，
      // 已存在的旧镜像必须删掉 —— 否则口径改了，历史污染却留在库里。
      // 走 removeTastingNotesForArticles 同一条路径（它只删 source=article
      // 的镜像并重算茶品统计，不动其它笔记）。
      if (existing) {
        await removeTastingNotesForArticles([articleId]);
        console.warn(
          `[tasting-note-sync] F0 单向流动：已删除不可入数据层的镜像笔记 article=${articleId} note=${existing.id} reason=${plan.reason}`,
        );
      }
      return alreadySynced ? "exists" : "skipped";
    }
    const d = plan.data;

    // 笔记 + 茶品统计放进同一个事务：统计是冗余缓存，不该出现「笔记写进去了、
    // 计数没跟上」的中间态。事务里只做本函数自己的事，不嵌套调用方的事务
    // （`publishArticles` 持有交互式事务，嵌套会死锁）。
    if (alreadySynced && existing) {
      await prisma.$transaction(async (tx) => {
        if (duplicates.length > 0) {
          await tx.tastingNote.deleteMany({ where: { id: { in: duplicates.map((n) => n.id) } } });
        }
        await tx.tastingNote.update({
          where: { id: existing.id },
          data: {
            title: d.title,
            content: d.content,
            summary: d.summary,
            images: d.images,
            videoUrl: d.videoUrl,
            // teaId/authorId/createdAt 不随编辑变化（作者与发贴时刻是帖子的固定属性）。
          },
        });
        // 内容同步不改评分/条数，重算只是顺手校正历史漂移（merge increment 事故的安全网）。
        await recomputeTeaStats(d.teaId, tx);
      });
      return "updated";
    }

    await prisma.$transaction(async (tx) => {
      await tx.tastingNote.create({ data: d });
      await recomputeTeaStats(d.teaId, tx);
    });
    return "created";
  } catch (e) {
    console.error(`[tasting-note-sync] 同步品鉴笔记失败 article=${articleId}`, e);
    return "skipped";
  }
}

/** 幂等：删除这些帖子镜像出来的品鉴笔记，并重算涉及的茶品统计。 */
export async function removeTastingNotesForArticles(articleIds: string[]): Promise<void> {
  const ids = [...new Set(articleIds.filter(Boolean))];
  if (ids.length === 0) return;
  try {
    // 只用 `sourceId: { in }` 单条件查询：@prisma/adapter-pg 7.8.0 对
    // 「标量相等 + 标量 in」的复合 where 会误报 P2022 ColumnNotFound
    // （见 article-publish.ts 里的同款注释）。`source` 在代码里判，成本为零。
    const notes = await prisma.tastingNote.findMany({
      where: { sourceId: { in: ids } },
      select: { id: true, teaId: true, source: true },
    });
    const mirrored = notes.filter((n) => n.source === ARTICLE_NOTE_SOURCE);
    if (mirrored.length === 0) return;

    await prisma.$transaction(async (tx) => {
      await tx.tastingNote.deleteMany({ where: { id: { in: mirrored.map((n) => n.id) } } });
      for (const teaId of new Set(mirrored.map((n) => n.teaId))) {
        await recomputeTeaStats(teaId, tx);
      }
    });
  } catch (e) {
    console.error(`[tasting-note-sync] 删除镜像品鉴笔记失败 articles=${ids.join(",")}`, e);
  }
}
