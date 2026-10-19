/**
 * 纯单测：`planArticleTastingNote` / `deriveNoteSummary` / `isMirrorNoteLive`。
 *
 * 这些用例锁住的是**不需要数据库就能证明**的业务规则，重点是三条最容易回归的：
 *  - 自动草稿（`tasting-draft_*`）绝不能镜像 —— 它本身就是从既有笔记改写出来的，
 *    镜像它会让同一篇笔记变成两条、`tastingNoteCount` 翻倍；
 *  - 私密帖绝不能镜像 —— `/tea/[id]` 取笔记没有任何可见性过滤；
 *  - 镜像笔记的可见性跟随源帖子（归档/翻私密时读取侧抑制，而不是删行）。
 *
 * Run: node --test --test-reporter=spec src/lib/tasting-note-plan.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planArticleTastingNote,
  deriveNoteSummary,
  isMirrorNoteLive,
  isDerivedTastingDraftId,
  ARTICLE_NOTE_SOURCE,
  SUMMARY_MAX_LENGTH,
  type NoteSourceArticle,
} from "./tasting-note-plan.ts";
// 故意 import 真正的那份实现：规划器为了「零导入」复制的常量必须与它一致，
// 不一致就由这条测试报出来，而不是等到线上多出一批孪生笔记才发现。
import { isTastingDraftId } from "./tea-drafts/id.ts";

const A = (over: Partial<NoteSourceArticle> = {}): NoteSourceArticle => ({
  id: "clh3k9d2f0000abcd1234efgh",
  title: "【跟进】2003 金大益5号青",
  content: "开汤记录：汤色橙黄透亮，入口蜜香明显。",
  summary: null,
  images: ["/uploads/forum/a.jpg"],
  videoUrl: null,
  authorId: "user-1",
  teaId: "tea-1",
  status: "published",
  visibility: "public",
  createdAt: new Date("2026-03-01T08:00:00.000Z"),
  ...over,
});

const NO_SYNC = { alreadySynced: false };

// ── 跳过条件 ────────────────────────────────────────────────

test("自动草稿（tasting-draft_*）不镜像：它本身就是既有笔记的改写", () => {
  const plan = planArticleTastingNote(A({ id: "tasting-draft_clh3k9d2f0000abcd1234efgh" }), NO_SYNC);
  assert.deepEqual(plan, { action: "skip", reason: "derived-from-note" });
});

test("漂移守卫：规划器复制的草稿前缀与 tea-drafts/id.ts 的实现判定一致", () => {
  const ids = [
    "tasting-draft_clh3k9d2f0000abcd1234efgh",
    "tasting-draft_",
    "tasting-drafts_xxx",
    "tasting-draft",
    "clh3k9d2f0000abcd1234efgh",
    "draft_tasting-x",
    "",
  ];
  for (const id of ids) {
    assert.equal(
      isDerivedTastingDraftId(id),
      isTastingDraftId(id),
      `两处对 ${JSON.stringify(id)} 的判定不一致`,
    );
  }
});

test("未关联茶品的帖子不镜像", () => {
  assert.deepEqual(planArticleTastingNote(A({ teaId: null }), NO_SYNC), {
    action: "skip",
    reason: "no-tea",
  });
});

for (const status of ["pending_review", "archived", "draft"]) {
  test(`status=${status} 不镜像（只镜像已发布）`, () => {
    assert.deepEqual(planArticleTastingNote(A({ status }), NO_SYNC), {
      action: "skip",
      reason: "not-published",
    });
  });
}

test("私密帖不镜像：笔记表没有可见性列，镜像即泄露到公开茶档案页", () => {
  assert.deepEqual(planArticleTastingNote(A({ visibility: "private" }), NO_SYNC), {
    action: "skip",
    reason: "private",
  });
});

test("没有作者不镜像（TastingNote.authorId 是必填外键）", () => {
  assert.deepEqual(planArticleTastingNote(A({ authorId: null }), NO_SYNC), {
    action: "skip",
    reason: "no-author",
  });
});

test("已同步过则跳过（幂等）", () => {
  assert.deepEqual(planArticleTastingNote(A(), { alreadySynced: true }), {
    action: "skip",
    reason: "already-synced",
  });
});

// ── 创建计划 ────────────────────────────────────────────────

test("合格的跟进帖 → 建笔记，字段映射正确且不写任何评分", () => {
  const article = A();
  const plan = planArticleTastingNote(article, NO_SYNC);
  assert.equal(plan.action, "create");
  if (plan.action !== "create") return;

  assert.equal(plan.data.source, ARTICLE_NOTE_SOURCE);
  assert.equal(plan.data.sourceId, article.id);
  assert.equal(plan.data.teaId, "tea-1");
  assert.equal(plan.data.authorId, "user-1");
  assert.equal(plan.data.content, article.content);
  assert.equal(plan.data.title, article.title);
  // createdAt 必须沿用发帖时间，否则回填的历史帖会全挤到时间线最前面
  assert.equal(plan.data.createdAt, article.createdAt);
  // 五维评分一律不写（跟进帖没有评分表单）
  assert.equal("appearance" in plan.data, false);
  assert.equal("taste" in plan.data, false);
  assert.equal("aftertaste" in plan.data, false);
});

test("images 为 null 时写成空数组而不是 null", () => {
  const plan = planArticleTastingNote(A({ images: null }), NO_SYNC);
  assert.equal(plan.action, "create");
  if (plan.action !== "create") return;
  assert.deepEqual(plan.data.images, []);
});

test("images 是新数组，不复用源对象引用", () => {
  const src = ["/uploads/forum/a.jpg"];
  const plan = planArticleTastingNote(A({ images: src }), NO_SYNC);
  assert.equal(plan.action, "create");
  if (plan.action !== "create") return;
  assert.deepEqual(plan.data.images, src);
  assert.notEqual(plan.data.images, src);
});

// ── 摘要派生 ────────────────────────────────────────────────

test("Article.summary 为空时从正文派生（跟进帖的 payload 里没有 summary 字段）", () => {
  const plan = planArticleTastingNote(A({ summary: null, content: "汤色橙黄" }), NO_SYNC);
  assert.equal(plan.action, "create");
  if (plan.action !== "create") return;
  assert.equal(plan.data.summary, "汤色橙黄");
});

test("已有 summary 时原样沿用", () => {
  const plan = planArticleTastingNote(A({ summary: "人工写的摘要" }), NO_SYNC);
  assert.equal(plan.action, "create");
  if (plan.action !== "create") return;
  assert.equal(plan.data.summary, "人工写的摘要");
});

test("纯图片帖（无文字）→ summary 为 null，时间线上不显示摘要行", () => {
  const plan = planArticleTastingNote(A({ summary: null, content: '<img src="x.jpg" alt="">' }), NO_SYNC);
  assert.equal(plan.action, "create");
  if (plan.action !== "create") return;
  assert.equal(plan.data.summary, null);
});

test("HTML 正文剥标签后折叠空白", () => {
  assert.equal(deriveNoteSummary("<p>汤色  橙黄</p><br/><p>蜜香明显</p>"), "汤色 橙黄 蜜香明显");
});

test("超长正文按码点截断到列宽上限并加省略号", () => {
  const long = "茶".repeat(600);
  const summary = deriveNoteSummary(long);
  assert.equal(summary, "茶".repeat(SUMMARY_MAX_LENGTH - 1) + "…");
  assert.equal([...(summary ?? "")].length, SUMMARY_MAX_LENGTH);
});

test("emoji 按码点计数：500 个 emoji 不会被截断", () => {
  const emojis = "🍵".repeat(500);
  const summary = deriveNoteSummary(emojis);
  assert.equal(summary, emojis);
});

test("刚好等于上限的正文不截断、不加省略号", () => {
  const exact = "茶".repeat(SUMMARY_MAX_LENGTH);
  assert.equal(deriveNoteSummary(exact), exact);
});

// ── 读取侧抑制 ──────────────────────────────────────────────

test("镜像笔记在源帖子仍可见时可见", () => {
  const live = new Set(["article-1"]);
  assert.equal(isMirrorNoteLive({ source: ARTICLE_NOTE_SOURCE, sourceId: "article-1" }, live), true);
});

test("镜像笔记在源帖子下架/送审/翻私密后不可见", () => {
  const live = new Set(["other-article"]);
  assert.equal(isMirrorNoteLive({ source: ARTICLE_NOTE_SOURCE, sourceId: "article-1" }, live), false);
});

test("镜像笔记缺 sourceId 时不可见（fail-closed）", () => {
  assert.equal(isMirrorNoteLive({ source: ARTICLE_NOTE_SOURCE, sourceId: null }, new Set()), false);
});

test("非镜像笔记（evernote/manual 导入）永远可见，不受帖子状态影响", () => {
  const empty = new Set<string>();
  assert.equal(isMirrorNoteLive({ source: "evernote", sourceId: null }, empty), true);
  assert.equal(isMirrorNoteLive({ source: "manual", sourceId: null }, empty), true);
  // 即便 sourceId 恰好撞上一个不存在的帖子，非镜像笔记也不该被抑制
  assert.equal(isMirrorNoteLive({ source: "evernote", sourceId: "gone" }, empty), true);
});
