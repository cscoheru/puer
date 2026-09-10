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

  const brands = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of teas) m.set(t.brand, (m.get(t.brand) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  }, [teas]);

  const filtered = useMemo(() => {
    let list = teas.filter((t) => (tab === "classic" ? t.isClassic : !t.isClassic));
    // 待审核 tab：只看有笔记的（归档产物）；经典 tab 全部
    if (tab === "pending") list = list.filter((t) => (t._count?.tastingNotes ?? t.tastingNoteCount) > 0);
    if (brandFilter) list = list.filter((t) => t.brand === brandFilter);
    if (search) list = list.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()) || t.brand.includes(search));
    return list.slice(0, 300);
  }, [teas, tab, search, brandFilter]);

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
    if (!q) { setMessage("请先输入目标茶品名称"); return; }
    const target = teas.find((t) => t.name === q) || teas.find((t) => t.name.includes(q));
    if (!target) { setMessage("未找到目标茶品，请输入准确名称"); return; }
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
      </div>

      {message && (
        <p className="mb-4 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">{message}</p>
      )}

      {loading ? (
        <p className="text-stone-400 text-sm py-8 text-center">加载中…</p>
      ) : (
        <div className="space-y-2">
          {filtered.map((t) => {
            const cnt = t._count?.tastingNotes ?? t.tastingNoteCount;
            const notes = openNotes[t.id];
            return (
              <div key={t.id} className="bg-white border border-stone-200 rounded-xl p-3">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <Link href={`/tea/${t.id}`} target="_blank" className="font-medium text-stone-800 hover:text-amber-700 text-sm truncate block">
                      {t.brand} · {t.name}
                    </Link>
                    <div className="text-xs text-stone-400 mt-0.5">
                      {t.year} · {t.type === "raw" ? "生茶" : "熟茶"} · {cnt} 篇笔记
                    </div>
                  </div>
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
                            value={mergeTarget[n.id] || ""}
                            onChange={(e) => setMergeTarget((prev) => ({ ...prev, [n.id]: e.target.value }))}
                            placeholder="合并到（茶名）"
                            className="px-2 py-1 text-xs border border-stone-200 rounded w-36 focus:border-amber-500 outline-none"
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
        </div>
      )}
    </div>
  );
}
