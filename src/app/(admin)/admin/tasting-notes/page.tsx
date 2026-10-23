"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseCsv } from "@/lib/tasting-corrections";

/**
 * 站长品鉴笔记的人工修正台（PRD v0.3 §5 Phase 1 的 F1 后续）。
 *
 * 站长线的数据是模型抽的，抽错的必须有人能改 —— 而且改的人不该是开发者。
 * 这里提供两条路：
 *  - **就地改**：表格里改完点保存（单条或批量），改过的字段 basis 标 manual；
 *  - **导出/导回**：导出 CSV（在 Excel 里改）再导入，规则与就地改完全一致
 *    （规则共用 src/lib/tasting-corrections.ts）。
 *
 * 单元格约定：留空 = 不改，`-` = 清空。
 */

interface Row {
  id: string;
  date: string;
  teaId: string | null;
  teaName: string;
  title: string;
  summary: string | null;
  stage: string | null;
  delta: string | null;
  grams: number | null;
  vessel: string | null;
  descriptors: string[];
  basis: Record<string, string | null>;
  needsReview: boolean;
}

interface Draft {
  stage: string;
  delta: string;
  grams: string;
  vessel: string;
  descriptors: string;
}

const STAGES: [string, string][] = [
  ["", "（空）"],
  ["ascending", "上升期"],
  ["peak", "巅峰期"],
  ["drinking", "适饮期"],
  ["declining", "走下坡"],
];
const DELTAS: [string, string][] = [
  ["", "（空）"],
  ["better", "更好"],
  ["same", "差不多"],
  ["worse", "更差"],
];

const toDraft = (r: Row): Draft => ({
  stage: r.stage ?? "",
  delta: r.delta ?? "",
  grams: r.grams != null ? String(r.grams) : "",
  vessel: r.vessel ?? "",
  descriptors: r.descriptors.join(","),
});

export default function AdminTastingNotesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [scope, setScope] = useState<"all" | "risky">("risky");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sp = new URLSearchParams({ scope, limit: "200" });
      if (q.trim()) sp.set("q", q.trim());
      const res = await fetch(`/api/admin/tasting-notes?${sp.toString()}`);
      const data = await res.json();
      const next: Row[] = data.page ?? [];
      setRows(next);
      const d: Record<string, Draft> = {};
      for (const r of next) d[r.id] = toDraft(r);
      setDrafts(d);
    } catch {
      setMessage("加载失败");
    } finally {
      setLoading(false);
    }
  }, [scope, q]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const dirty = useMemo(
    () =>
      rows
        .filter((r) => {
          const d = drafts[r.id];
          if (!d) return false;
          const orig = toDraft(r);
          return (
            d.stage !== orig.stage ||
            d.delta !== orig.delta ||
            d.grams !== orig.grams ||
            d.vessel !== orig.vessel ||
            d.descriptors !== orig.descriptors
          );
        })
        .map((r) => r.id),
    [rows, drafts],
  );

  const setField = (id: string, field: keyof Draft, value: string) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  };

  const save = async (ids: string[]) => {
    if (!ids.length) return;
    setSaving(true);
    try {
      const payload = ids.map((id) => {
        const d = drafts[id];
        return {
          id,
          stage: d.stage,
          delta: d.delta,
          grams: d.grams,
          vessel: d.vessel,
          descriptors: d.descriptors,
        };
      });
      const res = await fetch("/api/admin/tasting-notes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: payload }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage(
          `已保存 ${data.changed} 条${data.errors?.length ? `，${data.errors.length} 条有问题：${data.errors[0]}` : ""}`,
        );
        await load();
      } else {
        setMessage(data.error || "保存失败");
      }
    } catch {
      setMessage("保存失败");
    } finally {
      setSaving(false);
    }
  };

  // 导回 CSV：在 Excel 里改完的表，解析后按同一套规则回写。
  const importCsv = async (file: File) => {
    const text = await file.text();
    const { rows } = parseCsv(text);
    const payload = rows
      .filter((r) => r.id)
      .map((r) => ({
        id: r.id,
        stage: r.stage,
        delta: r.delta,
        grams: r.grams,
        vessel: r.vessel,
        descriptors: r.descriptors,
      }));
    if (!payload.length) {
      setMessage("这个文件里没有可导入的行（需要 id 列）");
      return;
    }
    if (!confirm(`确认导回 ${payload.length} 行？\n留空 = 不改，- = 清空。`)) return;

    setSaving(true);
    try {
      const res = await fetch("/api/admin/tasting-notes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: payload }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage(
          `导回完成：更新 ${data.changed} 行` +
            (data.errors?.length ? `，${data.errors.length} 行有问题：${data.errors[0]}` : ""),
        );
        await load();
      } else {
        setMessage(data.error || "导回失败");
      }
    } catch {
      setMessage("导回失败");
    } finally {
      setSaving(false);
    }
  };

  const exportCsv = () => {
    const sp = new URLSearchParams({ scope, format: "csv" });
    if (q.trim()) sp.set("q", q.trim());
    window.location.href = `/api/admin/tasting-notes?${sp.toString()}`;
  };

  return (
    <div className="max-w-7xl mx-auto py-8">
      <div className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-serif font-bold text-stone-800">品鉴笔记修正</h1>
          <p className="text-sm text-stone-500 mt-1">
            站长线的阶段、对比、克重、器具与描述词。改过的值会标记为「人工」。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={exportCsv}
            className="px-3 py-1.5 text-sm border border-stone-300 rounded hover:bg-stone-50"
          >
            导出 CSV
          </button>
          <label className="px-3 py-1.5 text-sm border border-stone-300 rounded hover:bg-stone-50 cursor-pointer">
            导入 CSV
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importCsv(f);
                e.target.value = "";
              }}
            />
          </label>
          <button
            onClick={() => save(dirty)}
            disabled={!dirty.length || saving}
            className="px-3 py-1.5 text-sm bg-amber-700 text-white rounded disabled:opacity-40 hover:bg-amber-800"
          >
            保存修改{dirty.length ? `（${dirty.length}）` : ""}
          </button>
        </div>
      </div>

      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as "all" | "risky")}
          className="text-sm px-2 py-1.5 border border-stone-300 rounded bg-white"
        >
          <option value="risky">只看高风险</option>
          <option value="all">全部笔记</option>
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") load();
          }}
          placeholder="搜索标题或摘要，回车确认"
          className="text-sm px-3 py-1.5 border border-stone-300 rounded flex-1 min-w-[200px]"
        />
        <button
          onClick={load}
          className="px-3 py-1.5 text-sm border border-stone-300 rounded hover:bg-stone-50"
        >
          查询
        </button>
      </div>

      {message && (
        <p className="mb-3 text-sm px-3 py-2 rounded bg-amber-50 text-amber-800 border border-amber-200">
          {message}
        </p>
      )}

      <div className="bg-white border border-stone-200 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-200 bg-stone-50">
              <th className="text-left px-3 py-2 font-medium text-stone-500 w-24">日期</th>
              <th className="text-left px-3 py-2 font-medium text-stone-500">茶品 / 标题</th>
              <th className="text-left px-3 py-2 font-medium text-stone-500 w-32">阶段</th>
              <th className="text-left px-3 py-2 font-medium text-stone-500 w-28">对比上次</th>
              <th className="text-left px-3 py-2 font-medium text-stone-500 w-20">克重</th>
              <th className="text-left px-3 py-2 font-medium text-stone-500 w-28">器具</th>
              <th className="text-left px-3 py-2 font-medium text-stone-500">描述词</th>
              <th className="text-left px-3 py-2 font-medium text-stone-500 w-28">来源</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-stone-400">
                  加载中…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-stone-400">
                  没有符合条件的笔记
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const d = drafts[r.id];
                if (!d) return null;
                const changed = dirty.includes(r.id);
                return (
                  <tr
                    key={r.id}
                    className={`border-b border-stone-100 ${changed ? "bg-amber-50/60" : ""}`}
                  >
                    <td className="px-3 py-2 text-stone-500 whitespace-nowrap">{r.date}</td>
                    <td className="px-3 py-2">
                      <div className="text-stone-800">{r.teaName}</div>
                      <div className="text-xs text-stone-400 truncate max-w-[280px]">
                        {r.title}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={d.stage}
                        onChange={(e) => setField(r.id, "stage", e.target.value)}
                        className="text-xs px-1.5 py-1 border border-stone-200 rounded bg-white"
                      >
                        {STAGES.map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={d.delta}
                        onChange={(e) => setField(r.id, "delta", e.target.value)}
                        className="text-xs px-1.5 py-1 border border-stone-200 rounded bg-white"
                      >
                        {DELTAS.map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        value={d.grams}
                        onChange={(e) => setField(r.id, "grams", e.target.value)}
                        placeholder="-"
                        className="w-14 text-xs px-1.5 py-1 border border-stone-200 rounded"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        value={d.vessel}
                        onChange={(e) => setField(r.id, "vessel", e.target.value)}
                        placeholder="-"
                        className="w-20 text-xs px-1.5 py-1 border border-stone-200 rounded"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        value={d.descriptors}
                        onChange={(e) => setField(r.id, "descriptors", e.target.value)}
                        placeholder="逗号分隔"
                        className="w-full text-xs px-1.5 py-1 border border-stone-200 rounded"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-[0.65rem] text-stone-400 leading-relaxed">
                        {Object.entries(r.basis)
                          .filter(([, v]) => v)
                          .map(([k, v]) => `${k}:${v}`)
                          .join(" ")}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {changed && (
                        <button
                          onClick={() => save([r.id])}
                          disabled={saving}
                          className="text-xs text-amber-700 hover:underline disabled:opacity-40"
                        >
                          保存
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-stone-400">
        阶段留空 = 清空该字段；克重/器具/描述词留空 = 不改。导出 CSV 后在 Excel 里改，
        填 `-` 表示清空，再导入即可（规则与这里完全一致）。
      </p>
    </div>
  );
}
