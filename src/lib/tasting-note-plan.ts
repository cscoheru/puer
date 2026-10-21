/**
 * 「帖子 → 品鉴笔记」镜像的**纯决策逻辑**（零导入、无 DB、无 `@/` 别名）。
 *
 * 拆成纯函数是照抄 `article-publish-plan.ts` 的既有约定：那个模块的注释写得很直白
 * ——「zero imports」。原因是双向的：`npm run test:unit` 用的 `node --test` 在 ESM 下
 * 不解析无扩展名的相对导入，而 Next/Turbopack 对同一批文件的解析规则又与它不同。
 * 零导入是唯一两边都安全的写法。DB 层在 `tasting-note-sync.ts`。
 *
 * 产品语义（用户原话）：跟进帖就是一篇独立的品鉴笔记，只是关联了具体茶品
 * （茶品库）。所以 `teaId != null` 的帖子在发布时要镜像出一条 tasting_note，
 * 让它按 createdAt 倒序成为该茶最新的品鉴笔记。
 */

/** `TastingNote.source` 的取值，标识「这条笔记镜像自一篇帖子」 */
export const ARTICLE_NOTE_SOURCE = "article";

/** `TastingNote.summary` 的列宽上限（schema `@db.VarChar(500)`） */
export const SUMMARY_MAX_LENGTH = 500;

/**
 * 自动草稿帖子的主键前缀。**与 `src/lib/tea-drafts/id.ts` 的 `PREFIX` 必须一致**。
 *
 * 这里刻意复制的常量而不是 import —— 见文件头「零导入」的说明。
 * 漂移风险由 `tasting-note-plan.test.ts` 里的一条断言兜住：那条测试直接 import
 * 真正的 `isTastingDraftId`，逐个比对两者对同一批 id 的判定，不一致就红。
 */
export const TASTING_DRAFT_ID_PREFIX = "tasting-draft_";

/** 是否是自动草稿管线产出的帖子（`tea-drafts/runner.ts`）。见 TASTING_DRAFT_ID_PREFIX。 */
export function isDerivedTastingDraftId(id: string): boolean {
  return typeof id === "string" && id.startsWith(TASTING_DRAFT_ID_PREFIX);
}

/** 规划器需要的最小 Article 切片 */
export interface NoteSourceArticle {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  images: string[] | null;
  videoUrl: string | null;
  authorId: string | null;
  teaId: string | null;
  status: string;
  visibility: string;
  createdAt: Date;
  /**
   * F0 内容来源（human | ai_from_notes | ai_autonomous | null 回填窗口）。
   * 单向流动规则：只有真人内容能进 TastingNote 数据层，所以非 human 一律
   * 不镜像。null 也不镜像——宁可漏建（backfill 后补跑即自愈），不可错放。
   */
  origin?: string | null;
  /**
   * 作者是否为系统控制的合成账号。F0：其行为不计入任何指标，也不得成为
   * 数据层的来源。origin 标注与这个标记是两道独立的闸 —— 标注可能因回填
   * 滞后而缺失，但账号身份是即时可判的。
   */
  authorIsSynthetic?: boolean;
}

/**
 * F0 单向流动闸：只有明确标注为 human、且作者不是合成账号的内容才允许进
 * 品鉴笔记数据层。
 *
 * 这里内联判定而不是 import content-origin.ts —— 本模块是 node --test 与
 * Next 双解析器都要吃的「零导入」模块（见文件头）。语义与
 * `originCanFeedDataLayer` 一致，content-origin 侧的测试已钉住该谓词。
 */
export function isHumanOrigin(origin: string | null | undefined): boolean {
  return origin === "human";
}

export type NoteSkipReason =
  /** 帖子本身就是从某条品鉴笔记派生出来的草稿，镜像它会造出重复笔记 */
  | "derived-from-note"
  | "no-tea"
  | "not-published"
  | "private"
  | "no-author"
  /** F0：AI 生成内容（或来源尚未回填）永不进入 TastingNote 数据层 */
  | "non-human-origin"
  /** F0：系统控制的合成账号所发内容永不进入 TastingNote 数据层 */
  | "synthetic-author"
  | "already-synced";

export interface NoteCreateData {
  title: string;
  content: string;
  summary: string | null;
  images: string[];
  videoUrl: string | null;
  teaId: string;
  authorId: string;
  source: typeof ARTICLE_NOTE_SOURCE;
  sourceId: string;
  createdAt: Date;
}

export type NotePlan =
  | { action: "create"; data: NoteCreateData }
  | { action: "skip"; reason: NoteSkipReason };

/**
 * 正文 → 摘要。
 *
 * 茶详情页对非 admin 只展示 `summary`（截断预览），所以摘要不能为空，
 * 否则镜像出来的跟进帖在时间线上是一行空白。正文可能是 HTML（编辑器产出），
 * 先剥标签再折叠空白。
 *
 * 按**码点**截断而不是 `String.slice`：Postgres 的 `VarChar(500)` 按字符计数，
 * 而 `slice` 按 UTF-16 码元计数，emoji（代理对）会被算成两个 —— 500 码元可能
 * 超过 500 字符，写入时被数据库拒绝。`[...text]` 展开成码点数组才是准确的。
 */
export function deriveNoteSummary(content: string): string | null {
  const text = content
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const codepoints = [...text];
  if (codepoints.length <= SUMMARY_MAX_LENGTH) return text;
  // 留一格给省略号，保证总长恰好不超过列宽
  return codepoints.slice(0, SUMMARY_MAX_LENGTH - 1).join("") + "…";
}

/**
 * 决定一条帖子该不该镜像成品鉴笔记。
 *
 * 顺序有讲究：先排除「派生帖」（`tasting-draft_*` 是从既有笔记生成的文章，
 * 镜像它会为同一篇笔记再造一条，`tastingNoteCount` 直接翻倍），再检查
 * 关联茶品 / 发布状态 / 可见性 / 作者，最后才是幂等。
 *
 * `private` 必须排除：`/tea/[id]` 取笔记的 where 只有 `{ teaId }`，没有任何
 * 可见性过滤（TastingNote 没有 status/visibility 列），私密帖一旦镜像就会把
 * 标题/摘要/图片挂到公开的茶档案页上。
 */
export function planArticleTastingNote(
  article: NoteSourceArticle,
  opts: { alreadySynced: boolean },
): NotePlan {
  // 自动草稿管线（tea-drafts）用 `tasting-draft_${noteId}` 作主键，文章是从
  // **已有的**品鉴笔记改写出来的 —— 镜像它等于给同一篇笔记造了个孪生兄弟。
  // 判据必须用 id 前缀而不是 `type === "tasting"`：通过 /api/articles 手工发的
  // `type: "tasting"` 帖子是真正的新品鉴，应该被镜像。
  if (isDerivedTastingDraftId(article.id)) return { action: "skip", reason: "derived-from-note" };
  if (!article.teaId) return { action: "skip", reason: "no-tea" };
  if (article.status !== "published") return { action: "skip", reason: "not-published" };
  if (article.visibility === "private") return { action: "skip", reason: "private" };
  if (!article.authorId) return { action: "skip", reason: "no-author" };
  // F0 单向流动：AI 内容与「尚未回填来源」的帖子都不进数据层。
  if (!isHumanOrigin(article.origin)) return { action: "skip", reason: "non-human-origin" };
  // F0：合成账号发的帖子不计入任何指标，也不得成为数据层来源。
  // 这是独立于 origin 标注的第二道闸 —— 标注可能滞后，账号身份不会。
  if (article.authorIsSynthetic) return { action: "skip", reason: "synthetic-author" };
  if (opts.alreadySynced) return { action: "skip", reason: "already-synced" };

  return {
    action: "create",
    data: {
      title: article.title.slice(0, 200),
      content: article.content,
      // 跟进帖走的是 /api/boards/[slug]，payload 里根本没有 summary 字段
      // → Article.summary 恒为 NULL，必须从 content 派生。
      summary: article.summary ?? deriveNoteSummary(article.content),
      // Article.images 是 String[]，TastingNote.images 是 Json?。
      // 写 `[]` 而不是 null：所有读取方都做 `Array.isArray(x) ? … : []`，两者等价，
      // 但空数组省掉一次 null 判断。
      images: [...(article.images ?? [])],
      videoUrl: article.videoUrl,
      teaId: article.teaId,
      authorId: article.authorId,
      source: ARTICLE_NOTE_SOURCE,
      sourceId: article.id,
      // 显式写 createdAt（该列是 @default(now()) 而非 @updatedAt，可以指定）：
      // 时间线按 createdAt 倒序，用写入时刻会让回填的历史帖全部挤到「最新」。
      createdAt: article.createdAt,
    },
  };
}

/**
 * 这条笔记现在能不能出现在公开的茶档案页上？
 *
 * 镜像笔记（`source === "article"`）的可见性**跟随源帖子**：帖子被下架、
 * 重新送审、或翻成私密时，笔记必须立刻消失。这就是「写入一次 + 读取时抑制」
 * 的读取侧 —— 比在归档时删笔记更好，因为归档是**可逆**的，而删笔记会连带
 * 删掉 `Comment.tastingNoteId` 的级联评论（schema 里是 onDelete: Cascade）。
 *
 * 非镜像笔记（evernote / manual 导入）永远可见。
 *
 * @param liveArticleIds 当前「已发布且非私密」的帖子 id 集合
 *                       （由 `visibleArticleWhere` 查出来的结果构成）。
 */
export function isMirrorNoteLive(
  note: { source: string; sourceId: string | null },
  liveArticleIds: ReadonlySet<string>,
): boolean {
  if (note.source !== ARTICLE_NOTE_SOURCE) return true;
  if (!note.sourceId) return false;
  return liveArticleIds.has(note.sourceId);
}
