"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";

interface Tea {
  id: string;
  name: string;
  brand: string;
  year: number;
  type: string;
  isClassic: boolean;
  tastingNoteCount: number;
  _count?: { tastingNotes: number };
}

function normalize(s: string) {
  return s.replace(/[\s\-_（）()\[\]【】「」,，.。]+/g, "").toLowerCase();
}

function similarity(a: string, b: string) {
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length < b.length ? a : b;
  if (longer.length === 0) return 1;
  const matches = [...shorter].filter((c, i) => c === longer[i]).length;
  return matches / longer.length;
}

/** R15 茶品合并（按品牌管理）：选中品牌 → 品牌内勾选多款 → 指定保留主体 → 批量合并。
 *  附品牌内相似度提示（阈值可调），辅助发现疑似重复。 */
export default function AdminTeasPage() {
  const [teas, setTeas] = useState<Tea[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [brand, setBrand] = useState("");
  const [filter, setFilter] = useState("");
  const [threshold, setThreshold] = useState(0.7);
  // 勾选待合并的茶品 id + 保留主体 id
  const [selected, setSelected] = useState<string[]>([]);
  const [keepId, setKeepId] = useState<string>("");

  useEffect(() => {
    fetch("/api/teas?limit=9999")
      .then((r) => r.json())
      .then((data) => setTeas(data.teas || []))
      .catch(() => setMessage("加载失败"))
      .finally(() => setLoading(false));
  }, []);

  // 品牌分组（按茶品数降序）
  const brandGroups = useMemo(() => {
    const m = new Map<string, Tea[]>();
    for (const t of teas) {
      const list = m.get(t.brand) || [];
      list.push(t);
      m.set(t.brand, list);
    }
    return [...m.entries()]
      .map(([name, list]) => ({ name, list }))
      .sort((a, b) => b.list.length - a.list.length || a.name.localeCompare(b.name, "zh"));
  }, [teas]);

  const activeGroup = useMemo(
    () => brandGroups.find((g) => g.name === brand) || null,
    [brandGroups, brand],
  );

  // 品牌内可见茶品（筛选词）
  const visible = useMemo(() => {
    if (!activeGroup) return [];
    if (!filter.trim()) return activeGroup.list;
    const q = filter.trim().toLowerCase();
    return activeGroup.list.filter((t) => t.name.toLowerCase().includes(q) || String(t.year).includes(q));
  }, [activeGroup, filter]);

  // 品牌内相似度提示（品牌内 n²，未知品牌 1257 款 ≈79 万次比较，可接受）
  const pairs = useMemo(() => {
    if (!activeGroup) return [];
    const list = activeGroup.list;
    const out: [Tea, Tea, number][] = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const score = similarity(normalize(list[i].name), normalize(list[j].name));
        if (score >= threshold) out.push([list[i], list[j], score]);
      }
    }
    return out.sort((a, b) => b[2] - a[2]).slice(0, 50);
  }, [activeGroup, threshold]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      // 主体默认第一个勾选；主体被取消则回落到剩余第一个
      setKeepId((k) => (next.length === 0 ? "" : k && next.includes(k) ? k : next[0]));
      return next;
    });
  }

  function pickPair(aId: string, bId: string) {
    setSelected([aId, bId]);
    setKeepId(aId);
  }

  const selectedTeas = useMemo(
    () => selected.map((id) => teas.find((t) => t.id === id)).filter(Boolean) as Tea[],
    [selected, teas],
  );

  const handleMerge = async () => {
    if (selected.length < 2 || !keepId) return;
    const keep = teas.find((t) => t.id === keepId);
    const removes = selectedTeas.filter((t) => t.id !== keepId);
    if (!confirm(`将 ${removes.length} 款茶品合并到「${keep?.name}」？\n被合并茶品的品鉴笔记/帖子将全部转移到保留主体，此操作不可撤销。`)) return;
    setMessage("合并中...");
    try {
      const res = await fetch("/api/admin/teas/merge-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepId, removeIds: removes.map((t) => t.id) }),
      });
      if (res.ok) {
        const data = await res.json();
        setMessage(`✓ 已合并 ${data.merged} 款（转移笔记 ${data.moved.tastingNotes} 篇、帖子 ${data.moved.articles} 篇）`);
        setTeas((prev) => prev.filter((t) => !removes.some((r) => r.id === t.id)));
        setSelected([]);
        setKeepId("");
      } else {
        const err = await res.json();
        setMessage(err.error || "合并失败");
      }
    } catch {
      setMessage("合并失败");
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">品茶论坛</Link>
        <span className="mx-2">/</span>
        <Link href="/admin" className="hover:text-amber-700 transition">管理后台</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">茶品合并</span>
      </nav>

      <h1 className="text-2xl font-serif font-bold text-stone-800 mb-2">茶品合并（按品牌）</h1>
      <p className="text-sm text-stone-500 mb-6">
        选择品牌 → 勾选多款疑似重复 → 指定保留主体（⭐）→ 批量合并。共 {teas.length} 个茶品、{brandGroups.length} 个品牌。
      </p>

      {message && (
        <p className="mb-4 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">{message}</p>
      )}

      {loading ? (
        <p className="text-stone-400 text-sm py-8 text-center">加载中...</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <select
              value={brand}
              onChange={(e) => { setBrand(e.target.value); setSelected([]); setKeepId(""); setFilter(""); }}
              className="px-3 py-1.5 text-sm border border-stone-200 rounded-lg bg-white focus:border-amber-500 outline-none"
            >
              <option value="">选择品牌…</option>
              {brandGroups.map((g) => (
                <option key={g.name} value={g.name}>
                  {g.name}（{g.list.length} 款）
                </option>
              ))}
            </select>
            {brand && (
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="品牌内筛选茶名/年份…"
                className="px-3 py-1.5 text-sm border border-stone-200 rounded-lg focus:border-amber-500 outline-none"
              />
            )}
          </div>

          {/* 批量合并操作条 */}
          {selected.length > 0 && (
            <div className="sticky top-0 z-10 mb-4 flex flex-wrap items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl">
              <span className="text-sm text-amber-800 font-medium">已勾选 {selected.length} 款</span>
              <span className="text-xs text-amber-700">
                保留主体：{keepId ? <span className="font-medium">⭐ {teas.find((t) => t.id === keepId)?.name}</span> : "未指定"}
              </span>
              <button
                onClick={handleMerge}
                disabled={selected.length < 2 || !keepId}
                className="px-3 py-1.5 text-xs bg-amber-800 text-white rounded-lg hover:bg-amber-900 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                🔗 合并所选到主体（{Math.max(selected.length - (keepId ? 1 : 0), 0)} 款并入）
              </button>
              <button
                onClick={() => { setSelected([]); setKeepId(""); }}
                className="px-3 py-1.5 text-xs border border-amber-300 text-amber-800 rounded-lg hover:bg-amber-100"
              >
                清空
              </button>
            </div>
          )}
          {activeGroup ? (
            <div className="grid gap-4 md:grid-cols-2">
              {/* 品牌内茶品列表 */}
              <div className="bg-white border border-stone-200 rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-sm font-medium text-stone-800">{brand} · {activeGroup.list.length} 款</h2>
                  <span className="text-[0.65rem] text-stone-400">☑ 待合并 · ◉ 保留主体</span>
                </div>
                <div className="max-h-[32rem] overflow-y-auto space-y-1">
                  {visible.length === 0 && (
                    <p className="text-xs text-stone-400 py-4 text-center">无匹配茶品</p>
                  )}
                  {visible.map((t) => {
                    const isSel = selected.includes(t.id);
                    const isKeep = keepId === t.id;
                    return (
                      <div
                        key={t.id}
                        className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 border transition ${
                          isKeep ? "bg-amber-50 border-amber-300" : isSel ? "bg-stone-50 border-stone-300" : "border-transparent hover:bg-stone-50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => toggle(t.id)}
                          className="accent-amber-800 shrink-0"
                        />
                        <input
                          type="radio"
                          name="keep-tea"
                          checked={isKeep}
                          onChange={() => { if (!isSel) toggle(t.id); setKeepId(t.id); }}
                          title="设为保留主体"
                          className="accent-amber-700 shrink-0"
                        />
                        <Link href={`/tea/${t.id}`} target="_blank" className="flex-1 min-w-0 text-xs text-stone-700 hover:text-amber-700 truncate">
                          {isKeep && <span className="mr-0.5">⭐</span>}
                          {t.name}
                          {t.isClassic && <span className="ml-1 text-amber-700">🏵️</span>}
                        </Link>
                        <span className="text-[0.65rem] text-stone-400 shrink-0">
                          {t.year} · {t._count?.tastingNotes ?? t.tastingNoteCount} 篇
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 疑似重复提示（品牌内） */}
              <div className="bg-white border border-stone-200 rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-sm font-medium text-stone-800">疑似重复（{pairs.length} 对）</h2>
                  <div className="flex items-center gap-1.5">
                    <label className="text-[0.65rem] text-stone-400">阈值</label>
                    <input
                      type="range"
                      min="0.4"
                      max="1"
                      step="0.05"
                      value={threshold}
                      onChange={(e) => setThreshold(parseFloat(e.target.value))}
                      className="w-20"
                    />
                    <span className="text-[0.65rem] text-stone-500">{threshold.toFixed(2)}</span>
                  </div>
                </div>
                <div className="max-h-[32rem] overflow-y-auto space-y-1.5">
                  {pairs.length === 0 && (
                    <p className="text-xs text-stone-400 py-4 text-center">该品牌内未发现疑似重复</p>
                  )}
                  {pairs.map(([a, b, score], i) => (
                    <div key={i} className="flex items-center gap-2 border border-stone-100 rounded-lg px-2.5 py-1.5">
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-stone-700 truncate">{a.name} <span className="text-stone-300">vs</span> {b.name}</div>
                        <div className="text-[0.65rem] text-stone-400">
                          相似 {(score * 100).toFixed(0)}% · {a.year}/{b.year} · {(a._count?.tastingNotes ?? a.tastingNoteCount) + (b._count?.tastingNotes ?? b.tastingNoteCount)} 篇
                        </div>
                      </div>
                      <button
                        onClick={() => pickPair(a.id, b.id)}
                        className="px-2 py-1 text-[0.65rem] border border-amber-300 text-amber-800 rounded hover:bg-amber-50 shrink-0"
                      >
                        勾选这对
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-stone-400 text-sm py-8 text-center">从上方选择一个品牌开始合并管理</p>
          )}
        </>
      )}
    </div>
  );
}
