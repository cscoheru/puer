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

interface Note {
  id: string;
  title: string;
  summary: string | null;
  createdAt: string;
  author: { username: string };
}

export default function AdminClassicsPage() {
  const [teas, setTeas] = useState<Tea[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<"pending" | "classic">("pending");
  const [search, setSearch] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  // R20 列表分页（此前一次渲染上千条且无分页，大品牌只能看到前一段）
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;
  // 展开的茶品 id -> 笔记列表（null=加载中）
  const [openNotes, setOpenNotes] = useState<Record<string, Note[] | null>>({});
  // 正在合并的笔记 id -> 输入的目标茶名
  const [mergeTarget, setMergeTarget] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/teas?limit=9999")
      .then((r) => r.json())
      .then((data) => setTeas(data.teas || []))
      .catch(() => setMessage("加载失败"))
      .finally(() => setLoading(false));
  }, []);

  // R20：品牌下拉展示全部品牌（此前只取前 20 个）
  const brands = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of teas) m.set(t.brand, (m.get(t.brand) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [teas]);

  const filtered = useMemo(() => {
    let list = teas.filter((t) => (tab === "classic" ? t.isClassic : !t.isClassic));
    // 待审核 tab：只看有笔记的（归档产物）；经典 tab 全部
    if (tab === "pending") list = list.filter((t) => (t._count?.tastingNotes ?? t.tastingNoteCount) > 0);
    if (brandFilter) list = list.filter((t) => t.brand === brandFilter);
    if (search) list = list.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()) || t.brand.includes(search));
    return list;
  }, [teas, tab, search, brandFilter]);

  // R20 分页：筛选条件变化回到第 1 页
  useEffect(() => {
    setPage(1);
  }, [tab, search, brandFilter]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const paged = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const pendingCount = useMemo(
    () => teas.filter((t) => !t.isClassic && (t._count?.tastingNotes ?? t.tastingNoteCount) > 0).length,
    [teas],
  );

  async function setClassic(teaId: string, isClassic: boolean) {
    setMessage(isClassic ? "发布中…" : "下架中…");
    const res = await fetch("/api/admin/teas/classic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teaId, isClassic }),
    });
    if (res.ok) {
      setTeas((prev) => prev.map((t) => (t.id === teaId ? { ...t, isClassic } : t)));
      setMessage(isClassic ? "✓ 已发布为经典普洱" : "✓ 已下架为归档待审");
    } else {
      const err = await res.json().catch(() => ({}));
      setMessage(err.error || "操作失败");
    }
  }

  async function loadNotes(teaId: string) {
    if (openNotes[teaId]) {
      setOpenNotes((prev) => { const n = { ...prev }; delete n[teaId]; return n; });
      return;
    }
    setOpenNotes((prev) => ({ ...prev, [teaId]: null }));
    const res = await fetch(`/api/admin/teas/${teaId}/notes`);
    const data = await res.json().catch(() => ({ notes: [] }));
    setOpenNotes((prev) => ({ ...prev, [teaId]: data.notes || [] }));
  }

  async function moveNote(noteId: string, fromTeaId: string) {
    const q = (mergeTarget[noteId] || "").trim();
    if (!q) { setMessage("请先输入目标茶品（支持 品牌 茶名 搜索）"); return; }
    // P2-R13：支持「品牌 茶名」/ 纯茶名 / 纯品牌 检索（datalist 候选为「品牌 茶名」标准格式）
    const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
    const target =
      teas.find((t) => norm(`${t.brand}${t.name}`) === norm(q) || norm(t.name) === norm(q)) ||
      teas.find((t) => `${t.brand} ${t.name}`.includes(q) || t.name.includes(q) || t.brand === q);
    if (!target) { setMessage("未找到目标茶品，请从候选中选择或输入准确名称"); return; }
    if (target.id === fromTeaId) { setMessage("笔记已属于该茶品"); return; }
    if (!confirm(`将此笔记合并到「${target.brand} ${target.name}」？`)) return;
    const res = await fetch("/api/admin/tasting-notes/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteId, targetTeaId: target.id }),
    });
    if (res.ok) {
      setMessage("✓ 笔记已合并");
      // 本地刷新两个茶的计数，并收起笔记列表
      setTeas((prev) => prev.map((t) => {
        const cnt = t._count?.tastingNotes ?? t.tastingNoteCount;
        if (t.id === fromTeaId) return { ...t, tastingNoteCount: Math.max(0, cnt - 1), _count: { tastingNotes: Math.max(0, cnt - 1) } };
        if (t.id === target.id) return { ...t, tastingNoteCount: cnt + 1, _count: { tastingNotes: cnt + 1 } };
        return t;
      }));
      setOpenNotes((prev) => { const n = { ...prev }; delete n[fromTeaId]; return n; });
      setMergeTarget((prev) => { const n = { ...prev }; delete n[noteId]; return n; });
    } else {
      const err = await res.json().catch(() => ({}));
      setMessage(err.error || "合并失败");
    }
  }

  async function splitNote(noteId: string, fromTeaId: string, noteTitle: string) {
    const name = prompt("新茶品名称（默认用笔记标题）：", noteTitle);
    if (name === null) return;
    const res = await fetch("/api/admin/tasting-notes/split", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noteId, name: name || undefined }),
    });
    if (res.ok) {
      setMessage(`✓ 已独立为新茶品（归档待审）：${name || noteTitle}`);
      setOpenNotes((prev) => { const n = { ...prev }; delete n[fromTeaId]; return n; });
      // 拉最新列表（含新茶品与计数）
      fetch("/api/teas?limit=9999").then((r) => r.json()).then((d) => setTeas(d.teas || [])).catch(() => {});
    } else {
      const err = await res.json().catch(() => ({}));
      setMessage(err.error || "拆分失败");
    }
  }

  // ── P2-R13 品牌修正：单茶编辑 + 按品牌批量 ──────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBrand, setBulkBrand] = useState("");

  async function changeBrand(teaIds: string[], brand: string) {
    if (!brand.trim()) { setMessage("请输入新品牌名"); return; }
    if (!confirm(`将 ${teaIds.length} 款茶的品牌改为「${brand.trim()}」？`)) return;
    const res = await fetch("/api/admin/teas/brand", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teaIds, brand }),
    });
    if (res.ok) {
      const data = await res.json();
      setTeas((prev) => prev.map((t) => (teaIds.includes(t.id) ? { ...t, brand: data.brand } : t)));
      setSelected(new Set());
      setBulkBrand("");
      setMessage(`✓ 已将 ${data.updated} 款茶品牌改为「${data.brand}」`);
    } else {
      const err = await res.json().catch(() => ({}));
      setMessage(err.error || "品牌修改失败");
    }
  }

  // ── P2-R14 品牌吧管理：品牌必须从现有品牌中勾选 ──────────────────
  interface Bar { id: string; key: string; label: string; icon: string | null; brands: string[]; sortOrder: number }
  const [showBars, setShowBars] = useState(false);
  const [bars, setBars] = useState<Bar[]>([]);
  const [brandList, setBrandList] = useState<{ id: string; name: string; teaCount: number }[]>([]);
  const [newBarLabel, setNewBarLabel] = useState("");

  async function loadBars() {
    const [barsRes, brandsRes] = await Promise.all([
      fetch("/api/admin/brand-bars").then((r) => r.json()).catch(() => ({ bars: [] })),
      fetch("/api/admin/brands").then((r) => r.json()).catch(() => ({ brands: [] })),
    ]);
    setBars(barsRes.bars || []);
    setBrandList(brandsRes.brands || []);
  }

  async function saveBar(bar: Bar, isNew = false) {
    if (bar.brands.length === 0) { setMessage("请先勾选至少一个品牌（品牌吧必须从现有品牌中创建）"); return; }
    const res = await fetch("/api/admin/brand-bars", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(isNew ? { key: bar.key, label: bar.label, icon: bar.icon, brands: bar.brands } : bar),
    });
    if (res.ok) {
      await loadBars();
      setMessage(isNew ? `✓ 新增吧「${bar.label}」` : `✓ 吧「${bar.label}」已保存`);
    } else {
      const err = await res.json().catch(() => ({}));
      setMessage(err.error || "保存失败");
    }
  }

  async function deleteBar(bar: Bar) {
    if (!confirm(`删除吧「${bar.label}」？其品牌将归入「其他吧」。`)) return;
    const res = await fetch("/api/admin/brand-bars", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: bar.id }),
    });
    if (res.ok) { await loadBars(); setMessage(`✓ 已删除「${bar.label}」`); }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">品茶论坛</Link>
        <span className="mx-2">/</span>
        <Link href="/admin" className="hover:text-amber-700 transition">管理后台</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">经典普洱审核</span>
      </nav>

      <h1 className="text-2xl font-serif font-bold text-stone-800 mb-1">🏵️ 经典普洱审核台</h1>
      <p className="text-sm text-stone-500 mb-4">
        茶品归档（茶品-品鉴笔记）审核发布后才会进入「经典普洱」区。待审核 {pendingCount} 款 · 已发布经典 {teas.filter((t) => t.isClassic).length} 款。
        归档不准确的笔记可展开茶品后「合并到其他茶」或「独立成新茶」。
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button
          onClick={() => setTab("pending")}
          className={`px-3 py-1.5 text-sm rounded-lg border transition ${tab === "pending" ? "bg-amber-800 text-white border-amber-800" : "bg-white text-stone-600 border-stone-200 hover:border-stone-300"}`}
        >
          待审核（{pendingCount}）
        </button>
        <button
          onClick={() => setTab("classic")}
          className={`px-3 py-1.5 text-sm rounded-lg border transition ${tab === "classic" ? "bg-amber-800 text-white border-amber-800" : "bg-white text-stone-600 border-stone-200 hover:border-stone-300"}`}
        >
          已发布经典（{teas.filter((t) => t.isClassic).length}）
        </button>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索茶品名/品牌…"
          className="px-3 py-1.5 text-sm border border-stone-200 rounded-lg focus:border-amber-500 outline-none"
        />
        <select
          value={brandFilter}
          onChange={(e) => setBrandFilter(e.target.value)}
          className="px-3 py-1.5 text-sm border border-stone-200 rounded-lg bg-white"
        >
          <option value="">全部品牌</option>
          {brands.map(([b, c]) => (
            <option key={b} value={b}>{b}（{c}）</option>
          ))}
        </select>
        <button
          onClick={() => { const v = !showBars; setShowBars(v); if (v && bars.length === 0) loadBars(); }}
          className="px-3 py-1.5 text-sm border border-amber-300 text-amber-800 bg-amber-50 rounded-lg hover:bg-amber-100 transition"
        >
          🏷️ 品牌吧管理
        </button>
      </div>

      {/* P2-R14 品牌吧管理面板：品牌从现有品牌勾选 */}
      {showBars && (
        <div className="mb-4 border border-amber-200 rounded-xl p-3 bg-amber-50/50 space-y-3">
          <p className="text-xs text-stone-500">
            品牌吧必须从现有品牌中勾选创建（品牌本身在「品牌管理」维护）；未归入任何吧的品牌自动进「其他吧」。
          </p>
          {bars.map((b, i) => (
            <div key={i} className="border border-stone-200 rounded-lg p-2 bg-white space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <input
                  value={b.icon || ""}
                  onChange={(e) => setBars((prev) => prev.map((x, j) => (j === i ? { ...x, icon: e.target.value } : x)))}
                  className="w-12 px-2 py-1 text-xs border border-stone-200 rounded text-center"
                  placeholder="图标"
                />
                <input
                  value={b.label}
                  onChange={(e) => setBars((prev) => prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  className="w-28 px-2 py-1 text-xs border border-stone-200 rounded"
                  placeholder="吧名"
                />
                <span className="text-xs text-stone-400">已选 {b.brands.length} 品牌</span>
                <div className="flex-1" />
                {!b.id && <span className="text-[0.65rem] text-amber-700">新吧（勾选品牌后保存）</span>}
                <button onClick={() => saveBar(b, !b.id)} className="px-2 py-1 text-xs bg-amber-800 text-white rounded hover:bg-amber-900 transition">保存</button>
                <button onClick={() => deleteBar(b)} disabled={!b.id} className="px-2 py-1 text-xs border border-stone-300 text-stone-500 rounded hover:bg-stone-100 transition disabled:opacity-40">删除</button>
              </div>
              <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
                {brandList.map((br) => {
                  const on = b.brands.includes(br.name);
                  return (
                    <button
                      key={br.id}
                      onClick={() =>
                        setBars((prev) =>
                          prev.map((x, j) =>
                            j === i
                              ? { ...x, brands: on ? x.brands.filter((y) => y !== br.name) : [...x.brands, br.name] }
                              : x,
                          ),
                        )
                      }
                      className={`px-2 py-0.5 text-xs rounded-full border transition ${on ? "bg-amber-800 text-white border-amber-800" : "bg-stone-50 text-stone-600 border-stone-200 hover:border-amber-400"}`}
                    >
                      {br.name}（{br.teaCount}）
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="flex items-center gap-1.5 pt-1 border-t border-amber-200">
            <input
              value={newBarLabel}
              onChange={(e) => setNewBarLabel(e.target.value)}
              placeholder="新增吧名（如：中茶吧）"
              className="px-2 py-1 text-xs border border-stone-200 rounded w-44"
            />
            <button
              onClick={() => {
                const label = newBarLabel.trim();
                if (!label) return;
                setBars((prev) => [...prev, { id: "", key: label, label, icon: "", brands: [], sortOrder: 99 }]);
                setNewBarLabel("");
              }}
              className="px-2 py-1 text-xs bg-stone-700 text-white rounded hover:bg-stone-800 transition"
            >
              + 新增吧（先加再勾品牌）
            </button>
          </div>
        </div>
      )}

      {/* P2-R13 批量改品牌：筛选到具体品牌后可勾选批量修正（如 大印藏→大益） */}
      {brandFilter && (
        <div className="mb-3 p-3 bg-stone-50 border border-stone-200 rounded-xl flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-stone-600">
            <input
              type="checkbox"
              checked={selected.size > 0 && filtered.length > 0 && filtered.every((t) => selected.has(t.id))}
              onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((t) => t.id)) : new Set())}
            />
            全选「{brandFilter}」（{filtered.length}）
          </label>
          <span className="text-xs text-stone-400">已选 {selected.size} 款</span>
          <input
            list="brand-options"
            value={bulkBrand}
            onChange={(e) => setBulkBrand(e.target.value)}
            placeholder="改为品牌…"
            className="px-2 py-1 text-xs border border-stone-200 rounded w-32 focus:border-amber-500 outline-none"
          />
          <button
            onClick={() => changeBrand([...selected], bulkBrand)}
            disabled={selected.size === 0}
            className="px-3 py-1 text-xs bg-amber-800 text-white rounded hover:bg-amber-900 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            批量改品牌
          </button>
        </div>
      )}

      {/* datalist：品牌候选（批量/编辑用）+ 茶品候选（笔记合并用，格式：品牌 茶名） */}
      <datalist id="brand-options">
        {brands.map(([b]) => (
          <option key={b} value={b} />
        ))}
      </datalist>
      <datalist id="tea-options">
        {teas.map((t) => (
          <option key={t.id} value={`${t.brand} ${t.name}`} />
        ))}
      </datalist>

      {message && (
        <p className="mb-4 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">{message}</p>
      )}

      {loading ? (
        <p className="text-stone-400 text-sm py-8 text-center">加载中…</p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-stone-400">
            共 {filtered.length} 款 · 第 {pageSafe} / {totalPages} 页（每页 {PAGE_SIZE} 款）
          </p>
          {paged.map((t) => {
            const cnt = t._count?.tastingNotes ?? t.tastingNoteCount;
            const notes = openNotes[t.id];
            return (
              <div key={t.id} className="bg-white border border-stone-200 rounded-xl p-3">
                <div className="flex items-center gap-3">
                  {brandFilter && (
                    <input
                      type="checkbox"
                      checked={selected.has(t.id)}
                      onChange={(e) => setSelected((prev) => { const n = new Set(prev); if (e.target.checked) n.add(t.id); else n.delete(t.id); return n; })}
                      className="shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <Link href={`/tea/${t.id}`} target="_blank" className="font-medium text-stone-800 hover:text-amber-700 text-sm truncate block">
                      {t.brand} · {t.name}
                    </Link>
                    <div className="text-xs text-stone-400 mt-0.5">
                      {t.year} · {t.type === "raw" ? "生茶" : "熟茶"} · {cnt} 篇笔记
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      const nb = prompt(`修改「${t.name}」的品牌（当前：${t.brand}）：`, t.brand);
                      if (nb !== null && nb.trim() && nb.trim() !== t.brand) changeBrand([t.id], nb);
                    }}
                    title="编辑品牌"
                    className="px-2 py-1.5 text-xs border border-stone-200 text-stone-500 rounded-lg hover:border-amber-400 hover:text-amber-700 transition shrink-0"
                  >
                    ✏️ 品牌
                  </button>
                  <button
                    onClick={() => loadNotes(t.id)}
                    className="px-3 py-1.5 text-xs border border-stone-200 text-stone-600 rounded-lg hover:border-stone-400 transition shrink-0"
                  >
                    {notes ? "收起笔记" : "笔记管理"}
                  </button>
                  {t.isClassic ? (
                    <button
                      onClick={() => setClassic(t.id, false)}
                      className="px-3 py-1.5 text-xs bg-stone-100 text-stone-600 border border-stone-300 rounded-lg hover:bg-stone-200 transition shrink-0"
                    >
                      下架
                    </button>
                  ) : (
                    <button
                      onClick={() => setClassic(t.id, true)}
                      className="px-3 py-1.5 text-xs bg-amber-800 text-white rounded-lg hover:bg-amber-900 transition shrink-0"
                    >
                      发布为经典 ✓
                    </button>
                  )}
                </div>

                {notes && (
                  <div className="mt-3 border-t border-stone-100 pt-3 space-y-2">
                    {notes.length === 0 && <p className="text-xs text-stone-400">无笔记</p>}
                    {notes.map((n) => (
                      <div key={n.id} className="flex flex-wrap items-center gap-2 bg-stone-50 rounded-lg p-2">
                        <div className="flex-1 min-w-0">
                          <span className="text-xs font-medium text-stone-700 block truncate">{n.title}</span>
                          <span className="text-[0.65rem] text-stone-400">
                            {n.author.username} · {new Date(n.createdAt).toLocaleDateString("zh-CN")}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <input
                            list="tea-options"
                            value={mergeTarget[n.id] || ""}
                            onChange={(e) => setMergeTarget((prev) => ({ ...prev, [n.id]: e.target.value }))}
                            placeholder="合并到（品牌/茶名）"
                            className="px-2 py-1 text-xs border border-stone-200 rounded w-40 focus:border-amber-500 outline-none"
                          />
                          <button
                            onClick={() => moveNote(n.id, t.id)}
                            className="px-2 py-1 text-xs bg-stone-700 text-white rounded hover:bg-stone-800 transition"
                          >
                            ↓ 合并
                          </button>
                          <button
                            onClick={() => splitNote(n.id, t.id, n.title)}
                            className="px-2 py-1 text-xs border border-amber-700 text-amber-800 rounded hover:bg-amber-50 transition"
                          >
                            ↑ 独立成茶
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {notes === null && <p className="mt-3 text-xs text-stone-400">加载笔记中…</p>}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <p className="text-stone-400 text-sm py-8 text-center">没有符合条件的茶品</p>
          )}

          {/* R20 分页导航：大列表（如品牌下几百款）翻页处理 */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 py-3">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={pageSafe <= 1}
                className="px-3 py-1.5 text-sm border border-stone-200 text-stone-600 rounded-lg hover:border-amber-400 disabled:opacity-40"
              >
                ‹ 上一页
              </button>
              <span className="text-xs text-stone-500">
                第 {pageSafe} / {totalPages} 页
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={pageSafe >= totalPages}
                className="px-3 py-1.5 text-sm border border-stone-200 text-stone-600 rounded-lg hover:border-amber-400 disabled:opacity-40"
              >
                下一页 ›
              </button>
              <select
                value={String(pageSafe)}
                onChange={(e) => setPage(parseInt(e.target.value, 10))}
                className="px-2 py-1.5 text-xs border border-stone-200 rounded-lg bg-white"
              >
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <option key={p} value={p}>跳到第 {p} 页</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
