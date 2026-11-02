import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EDITOR_UIDS,
  buildEditorStatement,
  deltaLabel,
  editorAuthorUids,
  editorLineHref,
  stageLabel,
  stageTone,
  type EditorTasting,
} from "./editor-line.ts";

const tasting = (over: Partial<EditorTasting> = {}): EditorTasting => ({
  id: "n1",
  title: "开汤",
  summary: null,
  source: "evernote",
  sourceId: null,
  createdAt: new Date("2024-01-01"),
  stage: "drinking",
  deltaVsPrev: null,
  grams: 7.5,
  vessel: "盖碗",
  descriptors: [],
  scores: { appearance: null, color: null, aroma: null, taste: null, aftertaste: null },
  basis: {},
  authorUid: 1001,
  ...over,
});

test("editorLineHref：镜像笔记跳帖子，原始笔记跳笔记页", () => {
  // 2026-11-02：站长线卡片要可点 —— 跳转目标靠 source/sourceId 拼
  assert.equal(
    editorLineHref({ id: "n1", source: "evernote", sourceId: null }),
    "/tasting/n1",
  );
  assert.equal(
    editorLineHref({ id: "n2", source: "article", sourceId: "a9" }),
    "/article/a9",
  );
  // 镜像但没有 sourceId（理论上不该发生）→ 落回笔记页，不拼出坏链接
  assert.equal(
    editorLineHref({ id: "n3", source: "article", sourceId: null }),
    "/tasting/n3",
  );
});

test("editorAuthorUids：没配就用默认，坏了也回落到默认", () => {
  assert.deepEqual(editorAuthorUids({}), [...DEFAULT_EDITOR_UIDS]);
  assert.deepEqual(editorAuthorUids({ EDITOR_AUTHOR_UIDS: "" }), [...DEFAULT_EDITOR_UIDS]);
  assert.deepEqual(editorAuthorUids({ EDITOR_AUTHOR_UIDS: "  " }), [...DEFAULT_EDITOR_UIDS]);
  assert.deepEqual(editorAuthorUids({ EDITOR_AUTHOR_UIDS: "abc" }), [...DEFAULT_EDITOR_UIDS]);
  assert.deepEqual(editorAuthorUids({ EDITOR_AUTHOR_UIDS: "1001, 1003" }), [1001, 1003]);
});

test("buildEditorStatement：没人写就没声明", () => {
  assert.equal(buildEditorStatement([]), null);
});

test("buildEditorStatement：人数按作者去重", () => {
  const one = buildEditorStatement([tasting(), tasting({ id: "n2" })]);
  assert.match(one ?? "", /站长线：一人/);
  const two = buildEditorStatement([
    tasting(),
    tasting({ id: "n2", authorUid: 1002 }),
  ]);
  assert.match(two ?? "", /站长线：2 人/);
});

test("buildEditorStatement：仓储如实说未记录，不编", () => {
  const s = buildEditorStatement([tasting()]);
  assert.match(s ?? "", /仓储未记录/);
});

test("buildEditorStatement：器具按原文写过的算，全是默认就说未记录", () => {
  const allDefault = buildEditorStatement([
    tasting({ basis: { vessel: "default" } }),
  ]);
  assert.match(allDefault ?? "", /器具未记录/);

  const oneVessel = buildEditorStatement([
    tasting({ vessel: "盖碗", basis: { vessel: "stated" } }),
  ]);
  assert.match(oneVessel ?? "", /器具 盖碗/);

  const mixed = buildEditorStatement([
    tasting({ vessel: "盖碗", basis: { vessel: "stated" } }),
    tasting({ id: "n2", vessel: "紫砂壶", basis: { vessel: "stated" } }),
  ]);
  assert.match(mixed ?? "", /器具不固定/);
});

test("stageLabel / deltaLabel：未知值返回 null，不硬编", () => {
  assert.equal(stageLabel("drinking"), "适饮期");
  assert.equal(stageLabel("ascending"), "上升期");
  assert.equal(stageLabel("decline"), null);
  assert.equal(stageLabel(null), null);

  assert.equal(deltaLabel("better"), "比上次好");
  assert.equal(deltaLabel("worse"), "比上次差");
  assert.equal(deltaLabel("same"), "与上次持平");
  assert.equal(deltaLabel(null), null);
});

test("stageTone：四个阶段各有配色，未知走中性", () => {
  const tones = ["ascending", "peak", "drinking", "declining"].map(stageTone);
  assert.equal(new Set(tones).size, 4, "四个阶段配色不能撞");
  assert.match(stageTone(null), /stone/);
});
