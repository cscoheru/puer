/**
 * 行情快照（F5 · PRD v0.3 §7 Phase 4）的数据访问层。
 *
 * 与 `src/lib/price-snapshot.ts` 分开：那个文件是纯函数（可离线单测），
 * 这个碰数据库。
 */
import { prisma } from "@/lib/prisma";
import type { PriceSnapshotRow } from "@/lib/price-snapshot";

const SNAPSHOT_SELECT = {
  id: true,
  teaId: true,
  snapshotDate: true,
  low: true,
  high: true,
  currency: true,
  sourceLabel: true,
  note: true,
} as const;

type SnapshotRowRaw = {
  id: string;
  teaId: string;
  snapshotDate: Date;
  low: number;
  high: number;
  currency: string;
  sourceLabel: string;
  note: string | null;
};

function toRow(r: SnapshotRowRaw): PriceSnapshotRow {
  return {
    id: r.id,
    teaId: r.teaId,
    snapshotDate: r.snapshotDate.toISOString().slice(0, 10),
    low: r.low,
    high: r.high,
    currency: r.currency,
    sourceLabel: r.sourceLabel,
    note: r.note,
  };
}

/** 一款茶的全部价格快照（按日期倒序）。 */
export async function listPriceSnapshots(teaId: string): Promise<PriceSnapshotRow[]> {
  const rows = await prisma.priceSnapshot.findMany({
    where: { teaId },
    orderBy: { snapshotDate: "desc" },
    select: SNAPSHOT_SELECT,
  });
  return rows.map(toRow);
}

/**
 * 站长线上的点（用来做「当时处于什么阶段」的对照）。
 *
 * 茶品页**已经有**站长线了（`getEditorLine`），所以这里不再自己查一遍 ——
 * 重复查一次站长线就是多一次全表扫。
 */
export function toEditorPoints(
  tastings: { createdAt: Date | string; stage?: string | null }[],
): { createdAt: string; stage: string | null }[] {
  return tastings.map((t) => ({
    createdAt:
      t.createdAt instanceof Date ? t.createdAt.toISOString() : String(t.createdAt),
    stage: t.stage ?? null,
  }));
}

/** 后台录入范围：经典茶 + 出现在任一用户茶仓里的茶（PRD F5 原文）。 */
export interface RecordableTea {
  id: string;
  name: string;
  brand: string;
  year: number;
  isClassic: boolean;
  /** 该茶有没有出现在某个用户的茶仓里。 */
  inCellar: boolean;
}

export async function listRecordableTeas(): Promise<RecordableTea[]> {
  const [classicTeas, cellarTeas] = await Promise.all([
    prisma.tea.findMany({
      where: { isClassic: true, deletedAt: null },
      select: { id: true, name: true, brand: true, year: true, isClassic: true },
      orderBy: [{ brand: "asc" }, { year: "asc" }, { name: "asc" }],
    }),
    prisma.cellarItem.findMany({
      where: { teaId: { not: null } },
      distinct: ["teaId"],
      select: { teaId: true },
    }),
  ]);

  const cellarTeaIds = new Set(
    cellarTeas.map((c) => c.teaId).filter((x): x is string => Boolean(x)),
  );

  // 茶仓里的茶可能不是经典（用户自建后被并入的普通茶）→ 单独查出来补进列表。
  const extraIds = [...cellarTeaIds].filter(
    (id) => !classicTeas.some((t) => t.id === id),
  );
  const extras = extraIds.length
    ? await prisma.tea.findMany({
        where: { id: { in: extraIds }, deletedAt: null },
        select: { id: true, name: true, brand: true, year: true, isClassic: true },
      })
    : [];

  return [...classicTeas, ...extras].map((t) => ({
    id: t.id,
    name: t.name,
    brand: t.brand,
    year: t.year,
    isClassic: t.isClassic,
    inCellar: cellarTeaIds.has(t.id),
  }));
}

/** 后台列表：全部快照（按日期倒序）。 */
export async function listAllPriceSnapshots(): Promise<
  (PriceSnapshotRow & { teaName: string; brand: string; year: number })[]
> {
  const rows = await prisma.priceSnapshot.findMany({
    orderBy: [{ snapshotDate: "desc" }, { createdAt: "desc" }],
    select: {
      ...SNAPSHOT_SELECT,
      tea: { select: { name: true, brand: true, year: true } },
    },
    take: 500,
  });
  return rows.map((r) => ({
    ...toRow(r),
    teaName: r.tea.name,
    brand: r.tea.brand,
    year: r.tea.year,
  }));
}

/** 某款茶最近一次快照的日期（用于「按季度」的提示）。 */
export async function latestSnapshotDate(
  teaId: string,
): Promise<string | null> {
  const row = await prisma.priceSnapshot.findFirst({
    where: { teaId },
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  return row ? row.snapshotDate.toISOString().slice(0, 10) : null;
}

export interface CreatePriceSnapshotInput {
  teaId: string;
  /** 快照日期（YYYY-MM-DD）。 */
  snapshotDate: string;
  low: number;
  high: number;
  currency?: string;
  sourceLabel: string;
  note?: string | null;
  enteredBy?: string | null;
}

/** 录一条快照。返回新行。 */
export async function createPriceSnapshot(
  input: CreatePriceSnapshotInput,
): Promise<PriceSnapshotRow> {
  const row = await prisma.priceSnapshot.create({
    data: {
      teaId: input.teaId,
      snapshotDate: new Date(`${input.snapshotDate}T00:00:00.000Z`),
      low: input.low,
      high: input.high,
      currency: input.currency ?? "CNY",
      sourceLabel: input.sourceLabel.trim(),
      note: input.note?.trim() || null,
      enteredBy: input.enteredBy ?? null,
    },
    select: SNAPSHOT_SELECT,
  });
  return toRow(row);
}

/** 删一条快照（录错了改不了就删）。 */
export async function deletePriceSnapshot(id: string): Promise<boolean> {
  const res = await prisma.priceSnapshot.deleteMany({ where: { id } });
  return res.count > 0;
}
