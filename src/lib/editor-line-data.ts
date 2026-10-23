/**
 * 站长线的数据访问（PRD v0.3 §5 Phase 1）。
 *
 * 与 `editor-line.ts` 分开：那个文件是纯函数（可单测），这个碰数据库。
 * `src/lib/prisma.ts` 在导入时就实例化 PrismaClient，混在一起就没法离线单测。
 */

import { prisma } from "@/lib/prisma";
import {
  buildEditorStatement,
  editorAuthorUids,
  type EditorLine,
  type EditorTasting,
} from "@/lib/editor-line.ts";
import type { Stage } from "@/lib/tasting-extract/vocab.ts";

const SELECT = {
  id: true,
  title: true,
  summary: true,
  createdAt: true,
  stage: true,
  deltaVsPrev: true,
  grams: true,
  vessel: true,
  descriptors: true,
  appearance: true,
  color: true,
  aroma: true,
  taste: true,
  aftertaste: true,
  extractionMeta: true,
  author: { select: { uid: true, username: true } },
} as const;

type RawNote = {
  id: string;
  title: string;
  summary: string | null;
  createdAt: Date;
  stage: string | null;
  deltaVsPrev: string | null;
  grams: number | null;
  vessel: string | null;
  descriptors: unknown;
  appearance: number | null;
  color: number | null;
  aroma: number | null;
  taste: number | null;
  aftertaste: number | null;
  extractionMeta: unknown;
  author: { uid: number; username: string };
};

function toEditorTasting(n: RawNote): EditorTasting {
  const meta = (n.extractionMeta ?? {}) as { basis?: Record<string, string | null> };
  return {
    id: n.id,
    title: n.title,
    summary: n.summary,
    createdAt: n.createdAt,
    stage: (n.stage as Stage | null) ?? null,
    deltaVsPrev: n.deltaVsPrev,
    grams: n.grams,
    vessel: n.vessel,
    descriptors: Array.isArray(n.descriptors) ? (n.descriptors as string[]) : [],
    scores: {
      appearance: n.appearance,
      color: n.color,
      aroma: n.aroma,
      taste: n.taste,
      aftertaste: n.aftertaste,
    },
    basis: meta.basis ?? {},
    authorUid: n.author.uid,
  };
}

/**
 * 取一款茶的站长线。旧 → 新（时间轴方向）。
 */
export async function getEditorLine(
  teaId: string,
  uids: number[] = editorAuthorUids(),
): Promise<EditorLine> {
  const notes = await prisma.tastingNote.findMany({
    where: {
      teaId,
      // AI/帖子镜像不进站长线（PRD §5 决策）
      source: { not: "article" },
      author: { uid: { in: uids } },
    },
    select: SELECT,
    orderBy: { createdAt: "asc" },
  });

  const tastings = (notes as unknown as RawNote[]).map(toEditorTasting);
  return {
    teaId,
    tastings,
    statement: buildEditorStatement(tastings),
  };
}

/** 批量取多款茶的站长线（经典款列表页用），避免 N+1。 */
export async function getEditorLines(
  teaIds: string[],
  uids: number[] = editorAuthorUids(),
): Promise<Map<string, EditorLine>> {
  const out = new Map<string, EditorLine>();
  if (!teaIds.length) return out;

  const notes = await prisma.tastingNote.findMany({
    where: {
      teaId: { in: teaIds },
      source: { not: "article" },
      author: { uid: { in: uids } },
    },
    select: { ...SELECT, teaId: true },
    orderBy: { createdAt: "asc" },
  });

  const byTea = new Map<string, EditorTasting[]>();
  for (const n of notes as unknown as (RawNote & { teaId: string })[]) {
    const t = toEditorTasting(n);
    if (!byTea.has(n.teaId)) byTea.set(n.teaId, []);
    byTea.get(n.teaId)!.push(t);
  }
  for (const teaId of teaIds) {
    const tastings = byTea.get(teaId) ?? [];
    out.set(teaId, { teaId, tastings, statement: buildEditorStatement(tastings) });
  }
  return out;
}

