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
 *
 * 管理员「代录」也走同一套：传**目标用户**的 userId 进来，不开后门。
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
        storageEpochs: {
          orderBy: { startsAt: "desc" },
          take: 1,
          select: { storageScore: true, city: true, container: true },
        },
        tastings: {
          orderBy: { tastedAt: "desc" },
          take: 1,
          select: { tastedAt: true, deltaVsPrev: true },
        },
        _count: { select: { tastings: true } },
      },
    }),
    prisma.cellarItem.count({ where: { userId } }),
  ]);

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
      tastingCount: r._count.tastings,
      lastTastedAt: r.tastings[0]?.tastedAt.toISOString() ?? null,
      lastDelta: r.tastings[0]?.deltaVsPrev ?? null,
      storageScore: r.storageEpochs[0]?.storageScore ?? null,
      storageCity: r.storageEpochs[0]?.city ?? null,
      storageContainer: r.storageEpochs[0]?.container ?? null,
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
    assessedBy?: "self" | "editor";
    city?: string | null;
    container?: string | null;
    legacyStorageLabel?: string | null;
  } | null;
}

/**
 * 新建一条茶仓条目。
 *
 * `userId` 是**条目所有者**。管理员代录时传目标用户的 id，
 * 额外用 `assessedBy: "editor"` 标注评分来源（PRD §6）。
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
                assessedBy: input.storage.assessedBy ?? "self",
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
  assessedBy?: "self" | "editor";
  city?: string | null;
  container?: string | null;
  legacyStorageLabel?: string | null;
}

/**
 * 换仓 —— 新增一条仓储期，旧的保留（历史要能还原）。
 *
 * **注意**：这里不检查 userId 就直接写会出事，所以先确认条目归属。
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
      assessedBy: input.assessedBy ?? "self",
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
  visibility?: "private" | "shared";
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
      visibility: input.visibility ?? "private",
      elapsedSeconds: input.elapsedSeconds ?? null,
    },
    select: { id: true },
  });
  return tasting.id;
}

/** 取一条目最近一次品鉴（快速品鉴表单用来「沿用上次」）。 */
export async function getLastTasting(
  userId: string,
  itemId: string,
): Promise<{
  grams: number | null;
  vessel: string | null;
  descriptors: string[];
  deltaVsPrev: string | null;
} | null> {
  const r = await prisma.cellarTasting.findFirst({
    where: { cellarItemId: itemId, userId },
    orderBy: { tastedAt: "desc" },
    select: { grams: true, vessel: true, descriptors: true, deltaVsPrev: true },
  });
  if (!r) return null;
  return {
    grams: r.grams,
    vessel: r.vessel,
    descriptors: asStringArray(r.descriptors),
    deltaVsPrev: r.deltaVsPrev,
  };
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
    const latest = r.storageEpochs[r.storageEpochs.length - 1];
    const currentStorage: ExportStorage | null = latest
      ? {
          startsAt: latest.startsAt.toISOString(),
          storageScore: latest.storageScore,
          assessedBy: latest.assessedBy,
          city: latest.city,
          container: latest.container,
          legacyStorageLabel: latest.legacyStorageLabel,
        }
      : null;

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
      currentStorage,
      tastings,
    };
  });
}

/**
 * 一键删除我的全部数据。
 *
 * PRD §4：用户数据可随时删除。级联删掉条目 → 品鉴 → 仓储期。
 * 自建茶品申请保留 —— 它是给**社区**的贡献，删掉会让站长白审。
 */
export async function purgeCellarData(
  userId: string,
): Promise<{ items: number; tastings: number }> {
  const before = await prisma.cellarTasting.count({ where: { userId } });
  const res = await prisma.cellarItem.deleteMany({ where: { userId } });
  return { items: res.count, tastings: before };
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
