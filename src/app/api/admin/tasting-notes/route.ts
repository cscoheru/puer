import { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin-auth";
import { planCorrections, toCsv, type CurrentValues } from "@/lib/tasting-corrections";
import { editorAuthorUids } from "@/lib/editor-line";

export const dynamic = "force-dynamic";

/** 站长原始笔记的作者白名单 —— 与站长线同一份配置。 */
const AUTHOR_UIDS = editorAuthorUids();

const CSV_HEADER = [
  "id",
  "日期",
  "茶品",
  "标题",
  "stage",
  "delta",
  "grams",
  "vessel",
  "descriptors",
  "当前来源",
];

async function listNotes(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const teaId = sp.get("teaId") || undefined;
  const year = sp.get("year") ? Number(sp.get("year")) : undefined;
  const q = (sp.get("q") || "").trim();
  const scope = sp.get("scope") || "all";
  const page = Math.max(1, Number(sp.get("page") || "1"));
  const limit = Math.min(200, Math.max(10, Number(sp.get("limit") || "50")));

  const where = {
    source: { not: "article" },
    author: { uid: { in: AUTHOR_UIDS } },
    ...(teaId ? { teaId } : {}),
    ...(year
      ? {
          createdAt: {
            gte: new Date(Date.UTC(year, 0, 1)),
            lt: new Date(Date.UTC(year + 1, 0, 1)),
          },
        }
      : {}),
    ...(q ? { OR: [{ title: { contains: q } }, { summary: { contains: q } }] } : {}),
  };

  const notes = await prisma.tastingNote.findMany({
    where,
    select: {
      id: true,
      title: true,
      summary: true,
      createdAt: true,
      stage: true,
      deltaVsPrev: true,
      grams: true,
      vessel: true,
      descriptors: true,
      extractionMeta: true,
      tea: { select: { id: true, name: true, year: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const rows = notes.map((n) => {
    const meta = (n.extractionMeta ?? {}) as {
      basis?: Record<string, string | null>;
      needsReview?: boolean;
    };
    return {
      id: n.id,
      date: n.createdAt.toISOString().slice(0, 10),
      createdAt: n.createdAt.toISOString(),
      teaId: n.tea?.id ?? null,
      teaName: n.tea ? `${n.tea.name}${n.tea.year ? ` ${n.tea.year}` : ""}` : "",
      title: n.title,
      summary: n.summary,
      stage: n.stage,
      delta: n.deltaVsPrev,
      grams: n.grams,
      vessel: n.vessel,
      descriptors: Array.isArray(n.descriptors)
        ? n.descriptors.filter((x): x is string => typeof x === "string")
        : [],
      basis: meta.basis ?? {},
      needsReview: Boolean(meta.needsReview),
    };
  });

  // scope=risky：只挑最值得人看的那些（结论性强、有出入、默认值可疑）
  const risky = rows.filter(
    (r) =>
      (r.stage && r.stage !== "drinking") ||
      r.delta ||
      r.needsReview ||
      (r.basis?.grams === "default" && /\d+\s*(克|g)/i.test(r.summary ?? "")),
  );

  const filtered = scope === "risky" ? risky : rows;
  const start = (page - 1) * limit;

  return { all: rows, filtered, paged: filtered.slice(start, start + limit) };
}

/** GET：列表（后台界面用）或 CSV 导出（?format=csv）。 */
export async function GET(req: NextRequest) {
  const { error } = await requirePermission("admin:content");
  if (error) return error;

  const { all, filtered, paged } = await listNotes(req);
  const format = req.nextUrl.searchParams.get("format");

  if (format === "csv") {
    const csv = toCsv(
      CSV_HEADER,
      filtered.map((r) => [
        r.id,
        r.date,
        r.teaName,
        r.title,
        r.stage ?? "",
        r.delta ?? "",
        r.grams ?? "",
        r.vessel ?? "",
        r.descriptors.join(","),
        Object.entries(r.basis)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}:${v}`)
          .join(" "),
      ]),
    );
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="tasting-notes-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  return Response.json({
    total: all.length,
    filtered: filtered.length,
    page: paged,
    pages: Math.max(1, Math.ceil(filtered.length / Number(req.nextUrl.searchParams.get("limit") || "50"))),
  });
}

/**
 * PUT：回写修正值。
 *
 * body: { rows: [{ id, stage?, delta?, grams?, vessel?, descriptors? }] }
 * 单元格约定与 CSV 相同：留空 = 不改，`-` = 清空。
 * 改动的字段会把 basis 标成 manual（与脚本回写完全一致 —— 规则共用
 * src/lib/tasting-corrections.ts）。
 */
export async function PUT(req: NextRequest) {
  const { error } = await requirePermission("admin:content");
  if (error) return error;

  let body: { rows?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return Response.json({ error: "没有要更新的行" }, { status: 400 });
  if (rows.length > 2000) {
    return Response.json({ error: "一次最多改 2000 行" }, { status: 400 });
  }

  const ids = rows
    .map((r) => (r as { id?: unknown }).id)
    .filter((x): x is string => typeof x === "string");
  const notes = await prisma.tastingNote.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      stage: true,
      deltaVsPrev: true,
      grams: true,
      vessel: true,
      descriptors: true,
      extractionMeta: true,
    },
  });
  const byId = new Map(notes.map((n) => [n.id, n]));

  const errors: string[] = [];
  const rollback: { id: string; before: Record<string, unknown> }[] = [];
  let changed = 0;

  for (const raw of rows) {
    const row = raw as {
      id: string;
      stage?: string | null;
      delta?: string | null;
      grams?: string | number | null;
      vessel?: string | null;
      descriptors?: string | null;
    };
    const note = byId.get(row.id);
    if (!note) {
      errors.push(`${row.id}：找不到这条笔记`);
      continue;
    }

    const current: CurrentValues = {
      id: note.id,
      stage: note.stage,
      deltaVsPrev: note.deltaVsPrev,
      grams: note.grams,
      vessel: note.vessel,
      descriptors: Array.isArray(note.descriptors)
        ? note.descriptors.filter((x): x is string => typeof x === "string")
        : [],
    };

    const plan = planCorrections(row, current);
    if (plan.errors.length) {
      errors.push(`${row.id.slice(0, 8)}：${plan.errors.join("；")}`);
    }
    if (!plan.changed) continue;

    const meta = (note.extractionMeta ?? {}) as Record<string, unknown>;
    const basis = { ...((meta.basis as Record<string, string | null>) ?? {}) };
    for (const f of plan.manualFields) basis[f] = "manual";

    // Json 字段不接受 null（那是 SQL NULL 的 DbNull），所以逐字段赋值。
    // 用 `in` 判断而不是真值 —— 清空某字段时值就是 null。
    const data: Prisma.TastingNoteUpdateInput = {
      extractionMeta: { ...meta, basis },
    };
    if ("stage" in plan.changes) data.stage = plan.changes.stage;
    if ("deltaVsPrev" in plan.changes) data.deltaVsPrev = plan.changes.deltaVsPrev;
    if ("grams" in plan.changes) data.grams = plan.changes.grams;
    if ("vessel" in plan.changes) data.vessel = plan.changes.vessel;
    if ("descriptors" in plan.changes) {
      data.descriptors =
        plan.changes.descriptors === null ? Prisma.DbNull : plan.changes.descriptors;
    }

    await prisma.tastingNote.update({ where: { id: note.id }, data });
    // 把改之前的值带回去：写错了还能还原（脚本版的回滚文件是同一回事）
    rollback.push({
      id: note.id,
      before: {
        stage: note.stage,
        deltaVsPrev: note.deltaVsPrev,
        grams: note.grams,
        vessel: note.vessel,
        descriptors: note.descriptors,
      },
    });
    changed++;
  }

  return Response.json({ ok: true, changed, errors, rollback });
}
