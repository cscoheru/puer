/**
 * F2「我的茶仓」的数据访问层（PRD v0.3 §5 Phase 2）。
 *
 * 与 `cellar.ts` 分开：那个文件是纯函数（可离线单测），这个碰数据库。
 * `src/lib/prisma.ts` 在导入时就实例化 PrismaClient，混在一起就没法离线单测。
 *
 * ## 一条贯穿全文件的隐私铁律
 *
 * **每个函数都显式收 userId，并且每条查询都按它过滤。**
 *
 * 站内 `api/favorites`、`api/tea-wish` 的 GET 收 `?userId=` 参数 ——
 * 那是能读别人数据的写法。这里不这么做：路由层从 session 解析出操作者，
 * 再把 userId 传进来；数据层一律 `where: { userId }`。
 * 传错 id 得到的是 `null`（找不到），不是别人的数据。
 */

import { prisma } from "@/lib/prisma";
import {
  type CellarDims,
  type ExportItem,
  type ExportStorage,
  type ExportTasting,
} from "@/lib/cellar.ts";
import type { Delta, Stage } from "@/lib/tasting-extract/vocab.ts";

// ─── JSON 安全读取 ────────────────────────────────────────────────────────

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asDims(v: unknown): CellarDims | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const src = v as Record<string, unknown>;
  const out: CellarDims = {};
  for (const key of ["aroma", "flavor", "waterPath", "bodyFeel"] as const) {
    const n = src[key];
    if (typeof n === "number" && Number.isInteger(n)) out[key] = n;
  }
  return Object.keys(out).length ? out : null;
}

// ─── 列表 ─────────────────────────────────────────────────────────────────

export interface CellarItemListRow {
  id: string;
  name: string | null;
  teaId: string | null;
  teaName: string | null;
  teaYear: number | null;
  teaBrand: string | null;
  teaType: string | null;
  acquiredAt: string | null;
  qtyNote: string | null;
  remindEveryMonths: number;
  nextRemindAt: string | null;
  createdAt: string;
  tastingCount: number;
  lastTastedAt: string | null;
  lastDelta: string | null;
  storageScore: number | null;
  storageCity: string | null;
  storageContainer: string | null;
}

/**
 * 列出某个用户的茶仓条目。
 *
 * 按最近一次品鉴时间倒序 —— 刚喝过的排在最前面，用户回访时不用翻。
 *
 * ## 为什么拆成四个查询而不是一次带关系
 *
 * Prisma 默认的关系加载策略是「query」：嵌套的 `take: 1` **不会**变成
 * SQL 的 LIMIT，而是把该页所有条目的全部仓储期/品鉴行拉回来、在引擎里
 * 再裁成 1 条。而 `_count` 会生成一个**没有过滤**的整表聚合
 * （`GROUP BY cellarItemId` 扫全表），LEFT JOIN 到列表查询上 ——
 * 开销随**全站**用量增长，而不是随这一页增长。
 *
 * 所以改成四个**页面范围**的查询：主表 + DISTINCT ON 取最新仓储期 +
 * DISTINCT ON 取最近一次品鉴 + 只对这页 id 分组计数。
 */
export async function listCellarItems(
  userId: string,
  opts: { page?: number; limit?: number } = {},
): Promise<{ items: CellarItemListRow[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const skip = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    prisma.cellarItem.findMany({
      where: { userId },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip,
      take: limit,
      select: {
        id: true,
        name: true,
        teaId: true,
        acquiredAt: true,
        qtyNote: true,
        remindEveryMonths: true,
        nextRemindAt: true,
        createdAt: true,
        tea: { select: { name: true, year: true, brand: true, type: true } },
      },
    }),
    prisma.cellarItem.count({ where: { userId } }),
  ]);

  const ids = rows.map((r) => r.id);
  if (!ids.length) return { items: [], total };

  // DISTINCT ON：每个条目只取一行（最新的一条）。Prisma 会把 distinct
  // 字段排到 ORDER BY 前面，语义就是 Postgres 的 DISTINCT ON。
  const [epochs, lastTastings, counts] = await Promise.all([
    prisma.storageEpoch.findMany({
      where: { cellarItemId: { in: ids } },
      orderBy: [{ startsAt: "desc" }],
      distinct: ["cellarItemId"],
      select: {
        cellarItemId: true,
        storageScore: true,
        city: true,
        container: true,
      },
    }),
    prisma.cellarTasting.findMany({
      where: { cellarItemId: { in: ids } },
      orderBy: [{ tastedAt: "desc" }],
      distinct: ["cellarItemId"],
      select: { cellarItemId: true, tastedAt: true, deltaVsPrev: true },
    }),
    // 计数只针对这一页的条目 —— 不做整表聚合。
    prisma.cellarTasting.groupBy({
      by: ["cellarItemId"],
      where: { cellarItemId: { in: ids } },
      _count: { _all: true },
    }),
  ]);

  const epochBy = new Map(epochs.map((e) => [e.cellarItemId, e]));
  const lastBy = new Map(lastTastings.map((t) => [t.cellarItemId, t]));
  const countBy = new Map(counts.map((c) => [c.cellarItemId, c._count._all]));

  return {
    total,
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      teaId: r.teaId,
      teaName: r.tea?.name ?? null,
      teaYear: r.tea?.year ?? null,
      teaBrand: r.tea?.brand ?? null,
      teaType: r.tea?.type ?? null,
      acquiredAt: r.acquiredAt?.toISOString() ?? null,
      qtyNote: r.qtyNote,
      remindEveryMonths: r.remindEveryMonths,
      nextRemindAt: r.nextRemindAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      tastingCount: countBy.get(r.id) ?? 0,
      lastTastedAt: lastBy.get(r.id)?.tastedAt.toISOString() ?? null,
      lastDelta: lastBy.get(r.id)?.deltaVsPrev ?? null,
      storageScore: epochBy.get(r.id)?.storageScore ?? null,
      storageCity: epochBy.get(r.id)?.city ?? null,
      storageContainer: epochBy.get(r.id)?.container ?? null,
    })),
  };
}

// ─── 单条详情 ─────────────────────────────────────────────────────────────

export interface CellarItemDetail {
  id: string;
  name: string | null;
  teaId: string | null;
  tea: { id: string; name: string; year: number; brand: string; type: string } | null;
  teaRequestId: string | null;
  acquiredAt: string | null;
  qtyNote: string | null;
  remindEveryMonths: number;
  nextRemindAt: string | null;
  createdAt: string;
  updatedAt: string;
  epochs: {
    id: string;
    startsAt: string;
    storageScore: number | null;
    assessedBy: string;
    city: string | null;
    container: string | null;
    legacyStorageLabel: string | null;
  }[];
  tastings: {
    id: string;
    tastedAt: string;
    stage: string | null;
    deltaVsPrev: string | null;
    dims: CellarDims | null;
    descriptors: string[];
    grams: number | null;
    vessel: string | null;
    note: string | null;
    images: string[];
    visibility: string;
    elapsedSeconds: number | null;
  }[];
}

const DETAIL_SELECT = {
  id: true,
  name: true,
  teaId: true,
  teaRequestId: true,
  acquiredAt: true,
  qtyNote: true,
  remindEveryMonths: true,
  nextRemindAt: true,
  createdAt: true,
  updatedAt: true,
  tea: { select: { id: true, name: true, year: true, brand: true, type: true } },
  storageEpochs: {
    orderBy: { startsAt: "asc" as const },
    select: {
      id: true,
      startsAt: true,
      storageScore: true,
      assessedBy: true,
      city: true,
      container: true,
      legacyStorageLabel: true,
    },
  },
  tastings: {
    orderBy: { tastedAt: "asc" as const },
    select: {
      id: true,
      tastedAt: true,
      stage: true,
      deltaVsPrev: true,
      dims: true,
      descriptors: true,
      grams: true,
      vessel: true,
      note: true,
      images: true,
      visibility: true,
      elapsedSeconds: true,
    },
  },
};

/** 取一条条目。**传别的用户的 id 会得到 null**（where 里带 userId）。 */
export async function getCellarItem(
  userId: string,
  itemId: string,
): Promise<CellarItemDetail | null> {
  const r = await prisma.cellarItem.findFirst({
    where: { id: itemId, userId },
    select: DETAIL_SELECT,
  });
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    teaId: r.teaId,
    tea: r.tea,
    teaRequestId: r.teaRequestId,
    acquiredAt: r.acquiredAt?.toISOString() ?? null,
    qtyNote: r.qtyNote,
    remindEveryMonths: r.remindEveryMonths,
    nextRemindAt: r.nextRemindAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    epochs: r.storageEpochs.map((e) => ({
      id: e.id,
      startsAt: e.startsAt.toISOString(),
      storageScore: e.storageScore,
      assessedBy: e.assessedBy,
      city: e.city,
      container: e.container,
      legacyStorageLabel: e.legacyStorageLabel,
    })),
    tastings: r.tastings.map((t) => ({
      id: t.id,
      tastedAt: t.tastedAt.toISOString(),
      stage: t.stage,
      deltaVsPrev: t.deltaVsPrev,
      dims: asDims(t.dims),
      descriptors: asStringArray(t.descriptors),
      grams: t.grams,
      vessel: t.vessel,
      note: t.note,
      images: asStringArray(t.images),
      visibility: t.visibility,
      elapsedSeconds: t.elapsedSeconds,
    })),
  };
}

// ─── 写入 ─────────────────────────────────────────────────────────────────

export interface CreateCellarItemInput {
  teaId?: string | null;
  teaRequestId?: string | null;
  name?: string | null;
  acquiredAt?: Date | null;
  qtyNote?: string | null;
  remindEveryMonths?: number;
  /** 首次登记的仓储信息（可全跳过）。 */
  storage?: {
    storageScore?: number | null;
    city?: string | null;
    container?: string | null;
    legacyStorageLabel?: string | null;
  } | null;
}

/**
 * 新建一条茶仓条目。
 *
 * `userId` 是**条目所有者**，也就是录入者本人 —— 没有代录。
 * 评分来源恒为「自评」：茶仓里的每一条记录都由用户本人录入
 * （2026-10-23 站长拍板）。DB 里那个 `assessedBy` 列保留着，
 * 它记的是**当时**这条评分是谁给的 —— 存量里可能有更早的「站长评」。
 */
export async function createCellarItem(
  userId: string,
  input: CreateCellarItemInput,
): Promise<string> {
  const created = await prisma.cellarItem.create({
    data: {
      userId,
      teaId: input.teaId ?? null,
      teaRequestId: input.teaRequestId ?? null,
      name: input.name ?? null,
      acquiredAt: input.acquiredAt ?? null,
      qtyNote: input.qtyNote ?? null,
      ...(input.remindEveryMonths != null
        ? { remindEveryMonths: input.remindEveryMonths }
        : {}),
      ...(input.storage
        ? {
            storageEpochs: {
              create: {
                storageScore: input.storage.storageScore ?? null,
                assessedBy: "self",
                city: input.storage.city ?? null,
                container: input.storage.container ?? null,
                legacyStorageLabel: input.storage.legacyStorageLabel ?? null,
              },
            },
          }
        : {}),
    },
    select: { id: true },
  });
  return created.id;
}

export interface UpdateCellarItemInput {
  name?: string | null;
  acquiredAt?: Date | null;
  qtyNote?: string | null;
  remindEveryMonths?: number;
  nextRemindAt?: Date | null;
}

/** 改条目。**改不到别人的条目**（where 里带 userId）。 */
export async function updateCellarItem(
  userId: string,
  itemId: string,
  input: UpdateCellarItemInput,
): Promise<boolean> {
  const data: Record<string, unknown> = {};
  if ("name" in input) data.name = input.name ?? null;
  if ("acquiredAt" in input) data.acquiredAt = input.acquiredAt ?? null;
  if ("qtyNote" in input) data.qtyNote = input.qtyNote ?? null;
  if ("remindEveryMonths" in input && input.remindEveryMonths != null) {
    data.remindEveryMonths = input.remindEveryMonths;
  }
  if ("nextRemindAt" in input) data.nextRemindAt = input.nextRemindAt ?? null;
  if (!Object.keys(data).length) return false;

  const res = await prisma.cellarItem.updateMany({
    where: { id: itemId, userId },
    data,
  });
  return res.count > 0;
}

/** 删条目。品鉴记录与仓储期随条目级联删除。 */
export async function deleteCellarItem(
  userId: string,
  itemId: string,
): Promise<boolean> {
  const res = await prisma.cellarItem.deleteMany({ where: { id: itemId, userId } });
  return res.count > 0;
}

export interface AddStorageEpochInput {
  startsAt?: Date;
  storageScore?: number | null;
  city?: string | null;
  container?: string | null;
  legacyStorageLabel?: string | null;
}

/**
 * 换仓 —— 新增一条仓储期，旧的保留（历史要能还原）。
 *
 * **注意**：这里不检查 userId 就直接写会出事，所以先确认条目归属。
 *
 * 评分来源恒为「自评」—— 换仓只服务本人，没有代录那条路。
 *
 * 评分**不在这里规整**：HTTP 路由上的 zod 已经挡住了越界值，DB 的 CHECK
 * 约束是第二道。中间再插一道「越界就当成没评分」会把**非法值静默降级** ——
 * 将来若有后台脚本从这里写库，它会拿到一条「看起来写成功了、其实分数丢了」
 * 的记录，而且 DB 的 CHECK 永远不会被触发，约束坏了也没人知道。
 * 要挡就在入口挡（zod），要么报错，不要静默吞掉。
 */
export async function addStorageEpoch(
  userId: string,
  itemId: string,
  input: AddStorageEpochInput,
): Promise<string | null> {
  const owned = await prisma.cellarItem.findFirst({
    where: { id: itemId, userId },
    select: { id: true },
  });
  if (!owned) return null;

  const epoch = await prisma.storageEpoch.create({
    data: {
      cellarItemId: itemId,
      startsAt: input.startsAt ?? new Date(),
      storageScore: input.storageScore ?? null,
      assessedBy: "self",
      city: input.city ?? null,
      container: input.container ?? null,
      legacyStorageLabel: input.legacyStorageLabel ?? null,
    },
    select: { id: true },
  });
  return epoch.id;
}

export interface AddTastingInput {
  tastedAt?: Date;
  stage?: Stage | null;
  deltaVsPrev?: Delta | null;
  dims?: CellarDims | null;
  descriptors?: string[];
  grams?: number | null;
  vessel?: string | null;
  note?: string | null;
  images?: string[];
  elapsedSeconds?: number | null;
}

/** 记一条品鉴。条目不存在或不属于该用户时返回 null。 */
export async function addTasting(
  userId: string,
  itemId: string,
  input: AddTastingInput,
): Promise<string | null> {
  const owned = await prisma.cellarItem.findFirst({
    where: { id: itemId, userId },
    select: { id: true },
  });
  if (!owned) return null;

  const tasting = await prisma.cellarTasting.create({
    data: {
      cellarItemId: itemId,
      userId,
      tastedAt: input.tastedAt ?? new Date(),
      stage: input.stage ?? null,
      deltaVsPrev: input.deltaVsPrev ?? null,
      dims: input.dims ?? undefined,
      descriptors: input.descriptors ?? undefined,
      grams: input.grams ?? null,
      vessel: input.vessel ?? null,
      note: input.note ?? null,
      images: input.images ?? undefined,
      // visibility 不由 API 决定 —— 恒为 private（DB 列的默认值）。
      elapsedSeconds: input.elapsedSeconds ?? null,
    },
    select: { id: true },
  });
  return tasting.id;
}

/**
 * 取一个条目的全部品鉴记录（时间轴）。
 *
 * 条目不存在或不属于该用户时返回 null（区别于「有条目但没有品鉴」——
 * 那种情况返回空数组）。
 */
export async function listItemTastings(
  userId: string,
  itemId: string,
): Promise<CellarItemDetail["tastings"] | null> {
  const owned = await prisma.cellarItem.findFirst({
    where: { id: itemId, userId },
    select: { id: true },
  });
  if (!owned) return null;

  const rows = await prisma.cellarTasting.findMany({
    where: { cellarItemId: itemId, userId },
    orderBy: { tastedAt: "asc" },
    select: {
      id: true,
      tastedAt: true,
      stage: true,
      deltaVsPrev: true,
      dims: true,
      descriptors: true,
      grams: true,
      vessel: true,
      note: true,
      images: true,
      visibility: true,
      elapsedSeconds: true,
    },
  });

  return rows.map((t) => ({
    id: t.id,
    tastedAt: t.tastedAt.toISOString(),
    stage: t.stage,
    deltaVsPrev: t.deltaVsPrev,
    dims: asDims(t.dims),
    descriptors: asStringArray(t.descriptors),
    grams: t.grams,
    vessel: t.vessel,
    note: t.note,
    images: asStringArray(t.images),
    visibility: t.visibility,
    elapsedSeconds: t.elapsedSeconds,
  }));
}

// ─── 导出与删除 ───────────────────────────────────────────────────────────

/** 导出某个用户的全部茶仓数据（JSON / CSV 共用这份数据）。 */
export async function exportCellarData(userId: string): Promise<ExportItem[]> {
  const rows = await prisma.cellarItem.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: DETAIL_SELECT,
  });

  return rows.map((r) => {
    const epochs: ExportStorage[] = r.storageEpochs.map((e) => ({
      startsAt: e.startsAt.toISOString(),
      storageScore: e.storageScore,
      assessedBy: e.assessedBy,
      city: e.city,
      container: e.container,
      legacyStorageLabel: e.legacyStorageLabel,
    }));
    const latest = epochs[epochs.length - 1] ?? null;

    const tastings: ExportTasting[] = r.tastings.map((t) => ({
      id: t.id,
      tastedAt: t.tastedAt.toISOString(),
      stage: t.stage,
      deltaVsPrev: t.deltaVsPrev,
      dims: asDims(t.dims),
      descriptors: asStringArray(t.descriptors),
      grams: t.grams,
      vessel: t.vessel,
      note: t.note,
      images: asStringArray(t.images),
      visibility: t.visibility,
      elapsedSeconds: t.elapsedSeconds,
    }));

    return {
      id: r.id,
      teaName: r.tea?.name ?? null,
      name: r.name,
      acquiredAt: r.acquiredAt?.toISOString() ?? null,
      qtyNote: r.qtyNote,
      remindEveryMonths: r.remindEveryMonths,
      currentStorage: latest,
      epochs,
      tastings,
    };
  });
}

/**
 * 一键删除我的全部数据。
 *
 * PRD §4：用户数据可随时删除。级联删掉条目 → 品鉴 → 仓储期。
 *
 * **自建茶品申请要区别对待**：申请本身是对**社区**的贡献（这款茶该
 * 进茶品库），删掉会让站长白审。但申请里的自由文本备注是**用户写的
 * 个人内容**，「删除我的全部数据」不能留着它 —— 所以清空备注，只留
 * 茶品名/品牌/年份/生熟这些「社区需要的信息」。
 */
export async function purgeCellarData(
  userId: string,
): Promise<{ items: number; tastings: number; requestsScrubbed: number }> {
  const before = await prisma.cellarTasting.count({ where: { userId } });
  const res = await prisma.cellarItem.deleteMany({ where: { userId } });
  // 备注是用户写的，清掉；申请本身留着给站长并入茶品库。
  const scrub = await prisma.teaRequest.updateMany({
    where: { userId, note: { not: null } },
    data: { note: null },
  });
  return { items: res.count, tastings: before, requestsScrubbed: scrub.count };
}

// ─── 自建茶品申请 ─────────────────────────────────────────────────────────

export interface TeaRequestInput {
  name: string;
  brand?: string | null;
  year?: number | null;
  type?: "raw" | "ripe";
  weightSpec?: string | null;
  note?: string | null;
}

export async function createTeaRequest(
  userId: string,
  input: TeaRequestInput,
): Promise<string> {
  const r = await prisma.teaRequest.create({
    data: {
      userId,
      name: input.name,
      brand: input.brand ?? null,
      year: input.year ?? null,
      type: input.type ?? "raw",
      weightSpec: input.weightSpec ?? null,
      note: input.note ?? null,
    },
    select: { id: true },
  });
  return r.id;
}

export interface TeaRequestRow {
  id: string;
  name: string;
  brand: string | null;
  year: number | null;
  type: string;
  weightSpec: string | null;
  note: string | null;
  status: string;
  mergedTeaId: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectReason: string | null;
  createdAt: string;
  requester: { uid: number | null; username: string; nickname: string | null };
  cellarItemCount: number;
}

/** 后台列出自建茶品申请。 */
export async function listTeaRequests(
  opts: { status?: string; page?: number; limit?: number } = {},
): Promise<{ rows: TeaRequestRow[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const where = opts.status ? { status: opts.status } : {};

  const [rows, total] = await Promise.all([
    prisma.teaRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        name: true,
        brand: true,
        year: true,
        type: true,
        weightSpec: true,
        note: true,
        status: true,
        mergedTeaId: true,
        reviewedBy: true,
        reviewedAt: true,
        rejectReason: true,
        createdAt: true,
        user: { select: { uid: true, username: true, nickname: true } },
        _count: { select: { cellarItems: true } },
      },
    }),
    prisma.teaRequest.count({ where }),
  ]);

  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      brand: r.brand,
      year: r.year,
      type: r.type,
      weightSpec: r.weightSpec,
      note: r.note,
      status: r.status,
      mergedTeaId: r.mergedTeaId,
      reviewedBy: r.reviewedBy,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      rejectReason: r.rejectReason,
      createdAt: r.createdAt.toISOString(),
      requester: {
        uid: r.user.uid,
        username: r.user.username,
        nickname: r.user.nickname,
      },
      cellarItemCount: r._count.cellarItems,
    })),
  };
}

/**
 * 审核一条自建茶品申请。
 *
 * 通过并入：把申请标成 approved、记下并入的茶品 id，并把引用这条申请的
 * 茶仓条目挂到该茶品上（用户加的茶终于能挂上站内茶品页的站长线了）。
 */
export async function reviewTeaRequest(
  actorId: string,
  requestId: string,
  action: "approve" | "reject",
  opts: { mergedTeaId?: string | null; rejectReason?: string | null } = {},
): Promise<boolean> {
  const status = action === "approve" ? "approved" : "rejected";
  const res = await prisma.teaRequest.updateMany({
    where: { id: requestId, status: "pending" },
    data: {
      status,
      reviewedBy: actorId,
      reviewedAt: new Date(),
      mergedTeaId: action === "approve" ? (opts.mergedTeaId ?? null) : null,
      rejectReason: action === "reject" ? (opts.rejectReason ?? null) : null,
    },
  });
  if (res.count === 0) return false;

  if (action === "approve" && opts.mergedTeaId) {
    await prisma.cellarItem.updateMany({
      where: { teaRequestId: requestId },
      data: { teaId: opts.mergedTeaId },
    });
  }
  return true;
}

// ─── 描述词库 ─────────────────────────────────────────────────────────────

/**
 * 选茶的搜索（用户侧与后台侧共用同一份查询）。
 *
 * 之前两个接口各写了一份 —— where、orderBy、take 全一样，只差 select。
 * 两份会各自漂移（比如别名匹配改了只改一边）。现在只有这一份。
 */
export async function searchCellarTeas(
  q: string,
  opts: { includeClassic?: boolean } = {},
): Promise<
  { id: string; name: string; brand: string | null; year: number | null; type: string | null; isClassic?: boolean }[]
> {
  const teas = await prisma.tea.findMany({
    where: {
      deletedAt: null,
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { brand: { contains: q, mode: "insensitive" } },
        { aliases: { has: q } },
      ],
    },
    // 经典优先，其次按品鉴笔记数（被品得多的通常是用户真正会买的）。
    orderBy: [{ isClassic: "desc" }, { tastingNoteCount: "desc" }],
    take: 20,
    select: {
      id: true,
      name: true,
      brand: true,
      year: true,
      type: true,
      ...(opts.includeClassic === false ? {} : { isClassic: true }),
    },
  });
  return teas;
}

export async function listVocab(opts: {
  category?: "raw" | "ripe" | "any";
  ageBracket?: string;
  dim?: string;
} = {}): Promise<
  { tag: string; category: string; ageBracket: string | null; dim: string | null }[]
> {
  const rows = await prisma.descriptorVocab.findMany({
    where: {
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.ageBracket ? { ageBracket: opts.ageBracket } : {}),
      ...(opts.dim ? { dim: opts.dim } : {}),
    },
    orderBy: { tag: "asc" },
    select: { tag: true, category: true, ageBracket: true, dim: true },
  });
  return rows;
}
