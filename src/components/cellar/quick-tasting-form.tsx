"use client";

import { useEffect, useRef, useState } from "react";
import { DELTA_LABELS, STAGE_LABELS } from "@/lib/cellar";
import type { Delta, Stage } from "@/lib/cellar";

/**
 * 快速品鉴（PRD v0.3 §5 Phase 2）。
 *
 * ## 三下点击
 *
 *   ①比上次（更好 / 差不多 / 更差）—— 首次品鉴不显示这一问
 *   ②状态阶段（上升期 / 巅峰期 / 适饮期 / 走下坡）
 *   ③保存
 *
 * 退出标准是「快速品鉴中位耗时 < 30 秒」，所以三问必须是**点选**而不是
 * 输入，四维、描述词、备注、图片、克重、器具全都折叠成可选项。
 *
 * ## 「默认沿用上次」
 *
 * 克重与器具默认带出上次的值 —— 同一条茶的冲泡口径不该每次都重新想。
 * 描述词也带出，但**默认不选中**（上次写「蜜香」，这次未必还是蜜香；
 * 默认勾上等于替用户说了话）。
 *
 * ## 耗时统计
 *
 * `elapsedSeconds` 从组件挂载算到保存成功 —— 服务端拿不到这个数，
 * 而它是 Phase 2 的退出指标，必须真实采集。
 */

const DELTAS: Delta[] = ["better", "same", "worse"];
const STAGES: Stage[] = ["ascending", "peak", "drinking", "declining"];

const DIM_FIELDS = [
  { key: "aroma", label: "香气" },
  { key: "flavor", label: "滋味" },
  { key: "waterPath", label: "水路" },
  { key: "bodyFeel", label: "体感" },
] as const;

export interface QuickTastingDefaults {
  grams: number | null;
  vessel: string | null;
  descriptors: string[];
  /** 上次有没有品鉴过（决定要不要问「比上次」）。 */
  hasPrevious: boolean;
  /** 上次的描述词（带出供参考，不默认选中）。 */
  previousDescriptors: string[];
}

export default function QuickTastingForm({
  itemId,
  defaults,
  vocab = [],
  onSaved,
}: {
  itemId: string;
  defaults: QuickTastingDefaults;
  /** 描述词库（点选用）。 */
  vocab?: string[];
  onSaved?: () => void;
}) {
  const [delta, setDelta] = useState<Delta | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [showOptional, setShowOptional] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  // 可选项
  const [dims, setDims] = useState<Record<string, number>>({});
  const [descriptors, setDescriptors] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [grams, setGrams] = useState<string>(
    defaults.grams != null ? String(defaults.grams) : "",
  );
  const [vessel, setVessel] = useState(defaults.vessel ?? "");

  const startedAt = useRef(Date.now());
  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  const toggleDescriptor = (tag: string) => {
    setDescriptors((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };

  const canSave = stage !== null && (defaults.hasPrevious ? delta !== null : true);

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const payload: Record<string, unknown> = {
        stage,
        elapsedSeconds: Math.round((Date.now() - startedAt.current) / 1000),
      };
      if (defaults.hasPrevious && delta) payload.deltaVsPrev = delta;
      if (Object.keys(dims).length) payload.dims = dims;
      if (descriptors.length) payload.descriptors = descriptors;
      if (note.trim()) payload.note = note.trim();
      if (grams.trim()) payload.grams = Number(grams);
      if (vessel.trim()) payload.vessel = vessel.trim();

      const res = await fetch(`/api/cellar/${itemId}/tastings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "保存失败");
        return;
      }
      setMessage("已记录");
      setDelta(null);
      setStage(null);
      setDims({});
      setDescriptors([]);
      setNote("");
      setShowOptional(false);
      startedAt.current = Date.now();
      onSaved?.();
    } catch {
      setError("保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white border border-stone-200 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-stone-800">快速品鉴</h3>
        <button
          onClick={() => setShowOptional((v) => !v)}
          className="text-xs text-stone-500 hover:text-amber-700 transition"
        >
          {showOptional ? "收起可选项" : "填更多（四维/描述词/备注…）"}
        </button>
      </div>

      {/* ① 比上次 —— 首次品鉴不显示 */}
      {defaults.hasPrevious && (
        <div className="mb-4">
          <p className="text-xs text-stone-500 mb-1.5">比上次</p>
          <div className="flex gap-2">
            {DELTAS.map((d) => (
              <button
                key={d}
                onClick={() => setDelta(d === delta ? null : d)}
                className={`flex-1 py-2 text-sm rounded-lg border transition ${
                  delta === d
                    ? "border-amber-600 bg-amber-50 text-amber-800 font-medium"
                    : "border-stone-200 text-stone-600 hover:border-amber-300"
                }`}
              >
                {DELTA_LABELS[d]}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ② 状态阶段 */}
      <div className="mb-4">
        <p className="text-xs text-stone-500 mb-1.5">状态阶段</p>
        <div className="flex gap-2 flex-wrap">
          {STAGES.map((s) => (
            <button
              key={s}
              onClick={() => setStage(s === stage ? null : s)}
              className={`flex-1 min-w-[4.5rem] py-2 text-sm rounded-lg border transition ${
                stage === s
                  ? "border-amber-600 bg-amber-50 text-amber-800 font-medium"
                  : "border-stone-200 text-stone-600 hover:border-amber-300"
              }`}
            >
              {STAGE_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      {showOptional && (
        <div className="mb-4 pt-4 border-t border-stone-100 space-y-4">
          {/* 四维 */}
          <div>
            <p className="text-xs text-stone-500 mb-1.5">四维评分（1–10）</p>
            <div className="grid grid-cols-2 gap-2">
              {DIM_FIELDS.map((f) => (
                <label key={f.key} className="flex items-center gap-2 text-sm">
                  <span className="text-stone-600 w-12 shrink-0">{f.label}</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    step={1}
                    value={dims[f.key] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setDims((prev) => {
                        const next = { ...prev };
                        if (!v) delete next[f.key];
                        else next[f.key] = Number(v);
                        return next;
                      });
                    }}
                    className="w-20 px-2 py-1.5 border border-stone-200 rounded text-sm"
                  />
                </label>
              ))}
            </div>
            {Object.keys(dims).length === 4 && (
              <p className="text-[0.7rem] text-stone-400 mt-1.5">
                综合分{" "}
                {(
                  (DIM_FIELDS.reduce((sum, f) => sum + (dims[f.key] ?? 0), 0) / 4)
                ).toFixed(1)}
              </p>
            )}
          </div>

          {/* 描述词 */}
          {vocab.length > 0 && (
            <div>
              <p className="text-xs text-stone-500 mb-1.5">描述词</p>
              <div className="flex flex-wrap gap-1.5">
                {vocab.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => toggleDescriptor(tag)}
                    className={`px-2 py-1 text-xs rounded-full border transition ${
                      descriptors.includes(tag)
                        ? "border-amber-600 bg-amber-50 text-amber-800"
                        : "border-stone-200 text-stone-500 hover:border-amber-300"
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 克重 / 器具 */}
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="text-xs text-stone-500">投茶量（克）</span>
              <input
                type="number"
                min={1}
                max={100}
                step={0.5}
                value={grams}
                onChange={(e) => setGrams(e.target.value)}
                className="w-full mt-1 px-2 py-1.5 border border-stone-200 rounded text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="text-xs text-stone-500">器具</span>
              <input
                value={vessel}
                onChange={(e) => setVessel(e.target.value)}
                placeholder="盖碗"
                className="w-full mt-1 px-2 py-1.5 border border-stone-200 rounded text-sm"
              />
            </label>
          </div>

          {/* 备注 */}
          <label className="block text-sm">
            <span className="text-xs text-stone-500">备注</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="w-full mt-1 px-2 py-1.5 border border-stone-200 rounded text-sm resize-y"
            />
          </label>
        </div>
      )}

      {/* ③ 保存 */}
      <button
        onClick={save}
        disabled={!canSave || saving}
        className="w-full py-2.5 text-sm bg-amber-700 text-white rounded-lg hover:bg-amber-800 transition disabled:opacity-40"
      >
        {saving ? "保存中…" : "保存"}
      </button>

      {!defaults.hasPrevious && (
        <p className="text-[0.7rem] text-stone-400 mt-2 text-center">
          第一次品鉴没有「比上次」
        </p>
      )}

      {message && (
        <p className="text-xs text-emerald-700 mt-2 text-center">{message}</p>
      )}
      {error && (
        <p className="text-xs text-red-600 mt-2 text-center">{error}</p>
      )}
    </div>
  );
}
