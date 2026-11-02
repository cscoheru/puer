/**
 * 站长线（PRD v0.3 §5 Phase 1）。
 *
 * ## 站长线是什么
 *
 * 某款茶上**站长自己**的品鉴时间序列：时间轴上的阶段、评分、器具、克重与
 * 描述词，下面挂一句来源声明。它是站内唯一「不依赖任何社区数据」的价值。
 *
 * ## 两个边界（PRD §5 决策）
 *
 * 1. **只用真人一手记录**：source ≠ 'article'。source='article' 是帖子/AI 文章
 *    发布时镜像出来的笔记，属衍生内容，不得进入站长线。
 * 2. **按作者白名单取，不看 role**：决策 2 明确「站长线只取 authorId 属于配置
 *    列表的作者，**不新增 role**」。白名单用 uid 表达（人读得懂），可用环境
 *    变量 EDITOR_AUTHOR_UIDS 覆盖。
 *
 * ## 来源声明
 *
 * PRD §5 F3 给了模板：「站长线：一人 · 一个家庭仓 · 器具不固定」。声明必须
 * **从数据里算**，不能写死 —— 人数看作者数、器具看出现过的器具种数、仓储在
 * F2 之前还没有数据，就如实说「仓储未记录」。
 */

// 相对路径：这个文件要被裸 node 直接跑单测（npm run test:unit 不带 tsx），
// 路径别名 @/ 在那里解析不了。
import { STAGE_LABELS, type Stage } from "./tasting-extract/vocab.ts";

/** 站长作者白名单默认值：渔夫（数据主力）与古道茶人（同一人另一个入口）。 */
export const DEFAULT_EDITOR_UIDS = [1001, 1002];

/**
 * 解析逗号分隔的 uid 列表。
 *
 * 容错口径：**写坏的那一项丢掉，其余照用**。整串都写坏时返回空数组 ——
 * 调用方据此回落到默认值，而不是「解析失败 = 放行所有人」。
 *
 * 站长线作者白名单（`editorAuthorUids`）与茶仓可见人群
 * （`cellarUidAllowlist`）共用这一份解析 —— 白名单口径一旦分叉，
 * 就会出现「站长线认得、茶仓不认」这种查不出来的错。
 */
export function parseUidList(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * 解析站长作者白名单。环境变量缺失或写坏时回落到默认值 ——
 * 白名单解析失败不该让站长线整个消失。
 */
export function editorAuthorUids(
  env: Record<string, string | undefined> = process.env,
): number[] {
  const ids = parseUidList((env.EDITOR_AUTHOR_UIDS ?? "").trim());
  return ids.length ? ids : [...DEFAULT_EDITOR_UIDS];
}

export interface EditorTasting {
  id: string;
  title: string;
  summary: string | null;
  /**
   * 记录来源：`evernote` / `manual` / `import`（站长的原始笔记）或
   * `article`（跟进帖的镜像）。
   *
   * 为什么要带上它：站长线的卡片要**可点**（2026-11-02 站长报「点不开」），
   * 而镜像笔记的正文页面是帖子（`/article/{sourceId}`），原始笔记才是
   * `/tasting/{id}` —— 没有 source/sourceId 就拼不出正确的跳转目标。
   */
  source: string;
  /** 镜像笔记对应的帖子 id（source === "article" 时有值）。 */
  sourceId: string | null;
  createdAt: Date;
  stage: Stage | null;
  deltaVsPrev: string | null;
  grams: number | null;
  vessel: string | null;
  descriptors: string[];
  scores: {
    appearance: number | null;
    color: number | null;
    aroma: number | null;
    taste: number | null;
    aftertaste: number | null;
  };
  /** 每个字段的来源：原文直述 / 推断 / 缺省值 / 人工。 */
  basis: Record<string, string | null>;
  authorUid: number;
}

export interface EditorLine {
  teaId: string;
  tastings: EditorTasting[];
  /** 来源声明；没有记录时为 null。 */
  statement: string | null;
}

/**
 * 生成来源声明。三段式：人数 · 仓储 · 器具。
 *
 * 仓储数据要等 F2「我的茶仓」才有，现在如实说「仓储未记录」而不是编一个。
 */
export function buildEditorStatement(tastings: EditorTasting[]): string | null {
  if (!tastings.length) return null;

  const authors = new Set(tastings.map((t) => t.authorUid));
  const people =
    authors.size === 1 ? "一人" : `${authors.size} 人`;

  // 器具：只有「原文写过」的才算数；全是缺省值就当没记录。
  const statedVessels = new Set(
    tastings
      .filter((t) => t.vessel && t.basis?.vessel === "stated")
      .map((t) => t.vessel as string),
  );
  const vesselPart =
    statedVessels.size === 0
      ? "器具未记录"
      : statedVessels.size === 1
        ? `器具 ${[...statedVessels][0]}`
        : "器具不固定";

  return `站长线：${people} · 仓储未记录 · ${vesselPart}`;
}

/**
 * 站长线一条记录的**跳转目标**。
 *
 * - 镜像笔记（跟进帖）→ 帖子页 `/article/{sourceId}`：那是它的正身，
 *   文章的可见性（published/private）由 `canViewArticleDetail` 判定，
 *   源帖被下架后链接自然失效 —— 不会出现「帖没了、笔记还在」。
 * - 原始笔记（站长的一手记录）→ 笔记页 `/tasting/{id}`。
 */
export function editorLineHref(t: Pick<EditorTasting, "id" | "source" | "sourceId">): string {
  if (t.source === "article" && t.sourceId) return `/article/${t.sourceId}`;
  return `/tasting/${t.id}`;
}

/** 阶段的中文标签；未知值返回 null。 */
export function stageLabel(stage: string | null): string | null {
  if (!stage) return null;
  return STAGE_LABELS[stage as Stage] ?? null;
}

/** 阶段标签的配色（tailwind 类名）。 */
export function stageTone(stage: string | null): string {
  switch (stage) {
    case "ascending":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "peak":
      return "bg-amber-50 text-amber-800 border-amber-200";
    case "drinking":
      return "bg-teal-50 text-teal-700 border-teal-200";
    case "declining":
      return "bg-stone-100 text-stone-600 border-stone-200";
    default:
      return "bg-stone-50 text-stone-500 border-stone-200";
  }
}

/** 「比上次」三档的中文标签。 */
export function deltaLabel(delta: string | null): string | null {
  if (delta === "better") return "比上次好";
  if (delta === "same") return "与上次持平";
  if (delta === "worse") return "比上次差";
  return null;
}
