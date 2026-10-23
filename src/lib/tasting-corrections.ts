/**
 * 品鉴笔记人工修正的**共用实现**（PRD v0.3 §5 Phase 1 的 F1 后续）。
 *
 * ## 为什么共用
 *
 * 站长改值有两条路：后台页面直接改，或导出 Excel 改完再导回。两条路必须
 * **用同一套规则**，否则「页面里能存、导回却存不进去」这种不一致会很难查。
 * 所以规则只写在这里，脚本（scripts/f1-corrections.mjs）与后台 API 都调它。
 *
 * ## 单元格约定
 *
 *   留空 / undefined = 不改这一项
 *   `-`              = 清空这一项（写回 null）
 *   实值             = 改成这个值
 *
 * 纯函数：不碰数据库，可离线单测。
 */

import { normalizeDelta, normalizeStage } from "./tasting-extract/vocab.ts";

/** 库里当前的取值。 */
export interface CurrentValues {
  id: string;
  stage: string | null;
  deltaVsPrev: string | null;
  grams: number | null;
  vessel: string | null;
  descriptors: string[] | null;
}

/** 一行编辑值（来自界面或表格）。 */
export interface CorrectionRow {
  id: string;
  stage?: string | null;
  delta?: string | null;
  grams?: string | number | null;
  vessel?: string | null;
  descriptors?: string | null;
}

export interface CorrectionPlan {
  /** 要写入的字段（只含真正变了的）。 */
  changes: {
    stage?: string | null;
    deltaVsPrev?: string | null;
    grams?: number | null;
    vessel?: string | null;
    descriptors?: string[] | null;
  };
  /** 改完后这些字段的 basis 应标成 manual。 */
  manualFields: string[];
  errors: string[];
  /** 是否有实际改动（值没变不算）。 */
  changed: boolean;
}

const CLEAR = "-";

/**
 * 描述词单元格 → 数组。
 *
 * 顿号可能就在词内部（模型写的「甜、柔且均衡」是一个词），所以：
 *  1. 只按逗号分段；
 *  2. 每一段若在库里原样存在就整段保留；
 *  3. 只有当它能被拆成库里已有的词时，才按顿号拆开。
 */
export function parseDescriptorCell(
  cell: string,
  current: string[] | null = null,
): string[] {
  const whole = (cell ?? "").trim();
  if (!whole) return [];
  const known = current ?? [];
  const out: string[] = [];
  for (const piece of whole.split(/[,，]/).map((s) => s.trim()).filter(Boolean)) {
    if (known.includes(piece)) {
      out.push(piece);
      continue;
    }
    const sub = piece.split(/[、;；\s]+/).map((s) => s.trim()).filter(Boolean);
    if (sub.length > 1 && sub.some((x) => known.includes(x))) out.push(...sub);
    else out.push(piece);
  }
  return out;
}

/**
 * 把一行的编辑值折算成「要改什么」。
 *
 * @param row     编辑值
 * @param current 库里现值（用来判断「有没有真的变」）
 */
export function planCorrections(
  row: CorrectionRow,
  current: CurrentValues,
): CorrectionPlan {
  const changes: CorrectionPlan["changes"] = {};
  const manualFields: string[] = [];
  const errors: string[] = [];

  const isBlank = (v: unknown) => v === undefined || v === null || v === "";
  const isClear = (v: unknown) => typeof v === "string" && v.trim() === CLEAR;

  // ── stage ──
  if (!isBlank(row.stage)) {
    if (isClear(row.stage)) {
      if (current.stage !== null) {
        changes.stage = null;
        manualFields.push("stage");
      }
    } else {
      const v = normalizeStage(row.stage);
      if (!v) errors.push(`stage 无法识别：${row.stage}`);
      else if (v !== current.stage) {
        changes.stage = v;
        manualFields.push("stage");
      }
    }
  }

  // ── delta ──
  if (!isBlank(row.delta)) {
    if (isClear(row.delta)) {
      if (current.deltaVsPrev !== null) {
        changes.deltaVsPrev = null;
        manualFields.push("deltaVsPrev");
      }
    } else {
      const v = normalizeDelta(row.delta);
      if (!v) errors.push(`delta 无法识别：${row.delta}`);
      else if (v !== current.deltaVsPrev) {
        changes.deltaVsPrev = v;
        manualFields.push("deltaVsPrev");
      }
    }
  }

  // ── grams ──
  if (!isBlank(row.grams)) {
    if (isClear(row.grams)) {
      if (current.grams !== null) {
        changes.grams = null;
        manualFields.push("grams");
      }
    } else {
      const n = Number(String(row.grams).replace(/[^\d.]/g, ""));
      if (!Number.isFinite(n) || n <= 0 || n > 100) {
        errors.push(`grams 不合理：${row.grams}`);
      } else if (current.grams === null || Math.abs(current.grams - n) > 1e-6) {
        changes.grams = n;
        manualFields.push("grams");
      }
    }
  }

  // ── vessel ──
  if (!isBlank(row.vessel)) {
    if (isClear(row.vessel)) {
      if (current.vessel !== null) {
        changes.vessel = null;
        manualFields.push("vessel");
      }
    } else {
      const v = String(row.vessel).trim();
      if (v.length > 40) errors.push(`器具太长（${v.length} 字，上限 40）`);
      else if (v !== current.vessel) {
        changes.vessel = v;
        manualFields.push("vessel");
      }
    }
  }

  // ── descriptors ──
  if (!isBlank(row.descriptors)) {
    const currentList = current.descriptors ?? [];
    if (isClear(row.descriptors)) {
      if (currentList.length) {
        changes.descriptors = null;
        manualFields.push("descriptors");
      }
    } else {
      const list = parseDescriptorCell(String(row.descriptors), currentList);
      if (list.join("\u0001") !== currentList.join("\u0001")) {
        changes.descriptors = list;
        manualFields.push("descriptors");
      }
    }
  }

  return {
    changes,
    manualFields,
    errors,
    changed: Object.keys(changes).length > 0,
  };
}

/** 导出的 CSV（带 BOM，Excel 打开不乱码）。 */
export function toCsv(
  header: string[],
  rows: (string | number | null | undefined)[][],
): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(esc).join(",")];
  for (const r of rows) lines.push(r.map(esc).join(","));
  return `\uFEFF${lines.join("\n")}\n`;
}

/**
 * 解析 CSV（支持引号包裹与转义双引号）。首行是表头。
 * 返回 { header, rows: Record<string,string>[] }。
 */
export function parseCsv(text: string): {
  header: string[];
  rows: Record<string, string>[];
} {
  const clean = text.replace(/^﻿/, "");
  const table: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    // 字段**开头**的引号是「这个字段被包起来了」，不是结束引号。
    // （早先的写法把开头引号当成结束，导致 `他说,"这是"标题` 还原成多一个引号。）
    if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      table.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    table.push(row);
  }

  const header = (table.shift() ?? []).map((h) => h.trim());
  const rows = table
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => {
      const o: Record<string, string> = {};
      header.forEach((h, i) => {
        o[h] = (r[i] ?? "").trim();
      });
      return o;
    });
  return { header, rows };
}
