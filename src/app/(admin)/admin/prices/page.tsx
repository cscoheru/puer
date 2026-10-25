"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatPriceRange, quarterHint } from "@/lib/price-snapshot";

interface RecordableTea {
  id: string;
  name: string;
  brand: string;
  year: number;
  isClassic: boolean;
  inCellar: boolean;
}

interface SnapshotRow {
  id: string;
  teaId: string;
  snapshotDate: string;
  low: number;
  high: number;
  currency: string;
  sourceLabel: string;
  note: string | null;
  teaName?: string;
  brand?: string;
  year?: number;
}

/**
 * 行情快照后台（F5 · PRD v0.3 §7 Phase 4）。
 *
 * ## 为什么是「手工录入区间」
 *
 * 普洱的行情不是一个数 —— 同一款茶在不同渠道/年份/品相下的成交价能差一截。
 * 录一个点价等于编一个精确的数字；录**区间**才是事实。所以这里只有
 * 「最低价 / 最高价」，没有「当前价」。
 *
 * ## 范围
 *
 * 经典茶 + 出现在任一用户茶仓里的茶（PRD F5 原文）。
 *
 * ## 频率
 *
 * 按季度（PRD）。但那是**约定不是约束** —— 距上次不到 90 天时给一句提醒，
 * 不拦：站长有理由补录时应该能录。
 */
export default function AdminPricesPage() {
  const [teas, setTeas] = useState<RecordableTea[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    snapshotDate: new Date().toISOString().slice(0, 10),
    low: "",
    high: "",
    sourceLabel: "",
    note: "",
  });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/price-snapshots");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error || "加载失败");
        return;
      }
      setTeas(Array.isArray(data.teas) ? data.teas : []);
      setSnapshots(Array.isArray(data.snapshots) ? data.snapshots : []);
    } catch {
      setMessage("加载失败");
    }
  }, []);

  useEffect(() => {
    // void + 微任务：直接调用会被 react-hooks 的 set-state-in-effect 规则
    // 判成「在 effect 里同步 setState」（仓库里其它页面也有这个历史问题）。
    void Promise.resolve().then(load);
  }, [load]);

  const filtered = useMemo(() => {
    const key = q.trim().toLowerCase();
    if (!key) return teas;
    return teas.filter(
      (t) =>
        t.name.toLowerCase().includes(key) ||
        t.brand.toLowerCase().includes(key) ||
        String(t.year).includes(key),
    );
  }, [teas, q]);

  const selected = teas.find((t) => t.id === selectedId) ?? null;
  const selectedSnapshots = useMemo(
    () =>
      snapshots
        .filter((s) => s.teaId === selectedId)
        .sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate)),
    [snapshots, selectedId],
  );
  const lastDate = selectedSnapshots[0]?.snapshotDate ?? null;
  const hint = quarterHint(lastDate);

  const submit = async () => {
    if (!selected) {
      setMessage("先选一款茶");
      return;
    }
    const low = Number(form.low);
    const high = Number(form.high);
    if (!form.low || !form.high || Number.isNaN(low) || Number.isNaN(high)) {
      setMessage("请填价格区间");
      return;
    }
    if (!form.sourceLabel.trim()) {
      setMessage("请填来源（这条价从哪来的）");
      return;
    }
    setBusy(true);
    setMessage("保存中…");
    try {
      const res = await fetch("/api/admin/price-snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teaId: selected.id,
          snapshotDate: form.snapshotDate,
          low,
          high,
          sourceLabel: form.sourceLabel.trim(),
          note: form.note.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error || "保存失败");
        return;
      }
      setMessage(`已录入「${selected.name}」${data.snapshot?.snapshotDate} 的行情。${data.hint ? `（${data.hint}）` : ""}`);
      setForm((f) => ({ ...f, low: "", high: "", sourceLabel: "", note: "" }));
      await load();
    } catch {
      setMessage("保存失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("删掉这条行情快照？\n快照是历史事实，删了就没了。")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/price-snapshots/${id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error || "删除失败");
        return;
      }
      setMessage("已删除。");
      await load();
    } catch {
      setMessage("删除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-6xl">
      <h1 className="text-2xl font-serif font-bold text-stone-800">行情快照</h1>
      <p className="text-sm text-stone-500 mt-1 mb-4">
        手工录入的**价格区间**序列（只录区间不录点值，必须填来源与日期）。
        范围：经典茶 + 出现在任一用户茶仓里的茶。建议按季度录一次。
      </p>

      {message && (
        <p className="mb-4 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">
          {message}
        </p>
      )}

      <div className="flex flex-col md:flex-row gap-4">
        {/* 茶品列表 */}
        <div className="md:w-1/2">
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索茶名 / 品牌 / 年份"
            className="w-full mb-3 px-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:border-amber-400"
          />
          <div className="bg-white border border-stone-200 rounded-lg max-h-[32rem] overflow-y-auto divide-y divide-stone-100">
            {filtered.length === 0 ? (
              <p className="text-sm text-stone-400 text-center py-10">
                {teas.length === 0 ? "加载中…" : "没有匹配的茶"}
              </p>
            ) : (
              filtered.map((t) => {
                const last = snapshots.find((s) => s.teaId === t.id);
                return (
                  <button
                    key={t.id}
                    onClick={() => {
                      setSelectedId(t.id);
                      setMessage("");
                    }}
                    className={`w-full text-left px-3 py-2.5 hover:bg-amber-50/50 transition ${selectedId === t.id ? "bg-amber-50" : ""}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-stone-800 truncate">{t.name}</span>
                      {t.isClassic && (
                        <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 shrink-0">
                          经典
                        </span>
                      )}
                      {t.inCellar && !t.isClassic && (
                        <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-stone-100 text-stone-500 shrink-0">
                          茶仓
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-stone-400 mt-0.5">
                      {t.brand} · {t.year}
                      {last
                        ? ` · 最近 ${formatPriceRange(last.low, last.high, last.currency)}（${last.snapshotDate}）`
                        : " · 还没录过"}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* 录入表单 + 历史 */}
        <div className="md:w-1/2">
          {!selected ? (
            <div className="bg-white border border-stone-200 rounded-lg p-8 text-center text-sm text-stone-400">
              左边选一款茶，就能录它的行情。
            </div>
          ) : (
            <div className="space-y-4">
              <div className="bg-white border border-stone-200 rounded-lg p-4">
                <h2 className="text-sm font-semibold text-stone-800 mb-1">
                  {selected.name}
                  <span className="ml-2 text-xs font-normal text-stone-400">
                    {selected.brand} · {selected.year}
                  </span>
                </h2>
                <p className="text-xs text-stone-400 mb-3">
                  {hint.text}
                  {hint.tooSoon && "（提示而已，不拦 —— 有理由可以补录）"}
                </p>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <label className="block">
                    <span className="text-xs text-stone-500">快照日期</span>
                    <input
                      type="date"
                      value={form.snapshotDate}
                      onChange={(e) => setForm({ ...form, snapshotDate: e.target.value })}
                      className="w-full mt-1 px-3 py-2 border border-stone-300 rounded-lg"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-stone-500">来源（必填）</span>
                    <input
                      type="text"
                      value={form.sourceLabel}
                      onChange={(e) => setForm({ ...form, sourceLabel: e.target.value })}
                      placeholder="如：东和 / 微拍堂 / 茶友私询"
                      className="w-full mt-1 px-3 py-2 border border-stone-300 rounded-lg"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-stone-500">区间下限（元）</span>
                    <input
                      type="number"
                      min={0}
                      value={form.low}
                      onChange={(e) => setForm({ ...form, low: e.target.value })}
                      className="w-full mt-1 px-3 py-2 border border-stone-300 rounded-lg"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-stone-500">区间上限（元）</span>
                    <input
                      type="number"
                      min={0}
                      value={form.high}
                      onChange={(e) => setForm({ ...form, high: e.target.value })}
                      className="w-full mt-1 px-3 py-2 border border-stone-300 rounded-lg"
                    />
                  </label>
                </div>
                <label className="block text-sm mt-3">
                  <span className="text-xs text-stone-500">备注</span>
                  <input
                    type="text"
                    value={form.note}
                    onChange={(e) => setForm({ ...form, note: e.target.value })}
                    placeholder="可选，比如品相、渠道、批次"
                    className="w-full mt-1 px-3 py-2 border border-stone-300 rounded-lg"
                  />
                </label>
                <button
                  onClick={submit}
                  disabled={busy}
                  className="mt-3 px-4 py-2 text-sm bg-amber-800 text-white rounded-lg hover:bg-amber-900 disabled:opacity-50"
                >
                  {busy ? "保存中…" : "录入这条行情"}
                </button>
              </div>

              <div className="bg-white border border-stone-200 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-stone-800 mb-2">
                  历史快照（{selectedSnapshots.length}）
                </h3>
                {selectedSnapshots.length === 0 ? (
                  <p className="text-sm text-stone-400 py-4 text-center">
                    还没录过
                  </p>
                ) : (
                  <div className="divide-y divide-stone-100">
                    {selectedSnapshots.map((s) => (
                      <div key={s.id} className="py-2 flex items-center gap-3">
                        <span className="text-sm text-stone-700 w-24 shrink-0 font-mono">
                          {s.snapshotDate}
                        </span>
                        <span className="text-sm text-stone-800">
                          {formatPriceRange(s.low, s.high, s.currency)}
                        </span>
                        <span className="text-xs text-stone-400 flex-1 truncate">
                          来源：{s.sourceLabel}
                          {s.note ? ` · ${s.note}` : ""}
                        </span>
                        <button
                          onClick={() => remove(s.id)}
                          disabled={busy}
                          className="text-xs text-stone-400 hover:text-red-600 shrink-0"
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
