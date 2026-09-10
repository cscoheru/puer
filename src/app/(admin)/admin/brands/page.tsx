"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";

interface Brand {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  teaCount: number;
}

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

export default function AdminBrandsPage() {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [teas, setTeas] = useState<Tea[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  // 展开的品牌 id -> 茶品搜索词
  const [openId, setOpenId] = useState<string | null>(null);
  const [teaSearch, setTeaSearch] = useState("");
  // 编辑中的品牌 id + 表单
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [newBrandName, setNewBrandName] = useState("");

  async function reload() {
    const [b, t] = await Promise.all([
      fetch("/api/admin/brands").then((r) => r.json()).catch(() => ({ brands: [] })),
      fetch("/api/teas?limit=9999").then((r) => r.json()).catch(() => ({ teas: [] })),
    ]);
    setBrands(b.brands || []);
    setTeas(t.teas || []);
  }

  useEffect(() => {
    reload().finally(() => setLoading(false));
  }, []);

  const filteredBrands = useMemo(() => {
    let list = brands;
    if (search) list = list.filter((b) => b.name.toLowerCase().includes(search.toLowerCase()));
    return [...list].sort((a, b) => b.teaCount - a.teaCount || a.name.localeCompare(b.name, "zh"));
  }, [brands, search]);

  const openBrand = brands.find((b) => b.id === openId) || null;

  // 该品牌下的茶品
  const brandTeas = useMemo(
    () => (openBrand ? teas.filter((t) => t.brand === openBrand.name) : []),
    [teas, openBrand],
  );

  // 搜索候选：不属于该品牌的茶（品牌+茶名检索），取前 20
  const candidates = useMemo(() => {
    if (!openBrand || !teaSearch.trim()) return [];
    const q = teaSearch.trim().toLowerCase();
    return teas
      .filter((t) => t.brand !== openBrand.name)
      .filter((t) => `${t.brand} ${t.name}`.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.brand.toLowerCase().includes(q))
      .slice(0, 20);
  }, [teas, openBrand, teaSearch]);

  async function saveBrand(b: Brand, name: string, description: string, icon?: string) {
    const res = await fetch("/api/admin/brands", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: b.id, name, description, icon: icon ?? b.icon }),
    });
    if (res.ok) {
      const data = await res.json();
      setMessage(data.renamed ? `✓ 品牌已改名「${data.from}」→「${data.to}」（茶品与品牌吧已同步）` : "✓ 品牌资料已保存");
      setEditId(null);
      await reload();
    } else {
      const err = await res.json().catch(() => ({}));
      setMessage(err.error || "保存失败");
    }
  }

  async function createBrand() {
    const name = newBrandName.trim();
    if (!name) return;
    const res = await fetch("/api/admin/brands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      setMessage(`✓ 已创建品牌「${name}」，展开后可搜索添加茶品`);
      setNewBrandName("");
      await reload();
    } else {
      const err = await res.json().catch(() => ({}));
      setMessage(err.error || "创建失败");
    }
  }

  async function deleteBrand(b: Brand) {
    if (!confirm(`删除品牌「${b.name}」？仅允许删除没有茶品的品牌。`)) return;
    const res = await fetch("/api/admin/brands", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: b.id }),
    });
    if (res.ok) {
      setMessage(`✓ 已删除品牌「${b.name}」`);
      if (openId === b.id) setOpenId(null);
      await reload();
    } else {
      const err = await res.json().catch(() => ({}));
      setMessage(err.error || "删除失败");
    }
  }

  async function addTeas(brandId: string, teaIds: string[]) {
    const res = await fetch("/api/admin/brands/teas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brandId, addTeaIds: teaIds }),
    });
    if (res.ok) {
      setMessage(`✓ 已划入 ${teaIds.length} 款茶品`);
      setTeaSearch("");
      await reload();
    } else {
      const err = await res.json().catch(() => ({}));
      setMessage(err.error || "操作失败");
    }
  }

  async function removeTea(brandId: string, teaId: string) {
    if (!confirm("移出该品牌？（茶品品牌将置为「未知」）")) return;
    const res = await fetch("/api/admin/brands/teas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brandId, removeTeaIds: [teaId] }),
    });
    if (res.ok) {
      setMessage("✓ 已移出（品牌置为「未知」）");
      await reload();
    } else {
      const err = await res.json().catch(() => ({}));
      setMessage(err.error || "操作失败");
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">品茶论坛</Link>
        <span className="mx-2">/</span>
        <Link href="/admin" className="hover:text-amber-700 transition">管理后台</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">品牌管理</span>
      </nav>

      <h1 className="text-2xl font-serif font-bold text-stone-800 mb-1">🏷️ 品牌管理</h1>
      <p className="text-sm text-stone-500 mb-4">
        先有品牌，后有品牌吧。共 {brands.length} 个品牌、{teas.length} 款茶品；一个茶品只隶属一个品牌。
        改名会同步其下全部茶品与品牌吧配置。
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索品牌…"
          className="px-3 py-1.5 text-sm border border-stone-200 rounded-lg focus:border-amber-500 outline-none"
        />
        <input
          value={newBrandName}
          onChange={(e) => setNewBrandName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") createBrand(); }}
          placeholder="新建品牌名…"
          className="px-3 py-1.5 text-sm border border-stone-200 rounded-lg focus:border-amber-500 outline-none"
        />
        <button
          onClick={createBrand}
          className="px-3 py-1.5 text-sm bg-amber-800 text-white rounded-lg hover:bg-amber-900 transition"
        >
          + 创建品牌
        </button>
      </div>

      {message && (
        <p className="mb-4 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">{message}</p>
      )}

      {loading ? (
        <p className="text-stone-400 text-sm py-8 text-center">加载中…</p>
      ) : (
        <div className="space-y-2">
          {filteredBrands.map((b) => (
            <div key={b.id} className="bg-white border border-stone-200 rounded-xl p-3">
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-stone-800 text-sm">
                    {b.icon} {b.name}
                  </span>
                  {b.description && <span className="text-xs text-stone-400 ml-2">{b.description}</span>}
                  <div className="text-xs text-stone-400 mt-0.5">{b.teaCount} 款茶品</div>
                </div>
                <button
                  onClick={() => { setOpenId(openId === b.id ? null : b.id); setTeaSearch(""); }}
                  className="px-3 py-1.5 text-xs border border-stone-200 text-stone-600 rounded-lg hover:border-stone-400 transition shrink-0"
                >
                  {openId === b.id ? "收起" : "茶品管理"}
                </button>
                <button
                  onClick={() => { setEditId(editId === b.id ? null : b.id); setEditName(b.name); setEditDesc(b.description || ""); }}
                  className="px-3 py-1.5 text-xs border border-stone-200 text-stone-500 rounded-lg hover:border-amber-400 hover:text-amber-700 transition shrink-0"
                >
                  ✏️ 资料
                </button>
                <button
                  onClick={() => deleteBrand(b)}
                  disabled={b.teaCount > 0}
                  title={b.teaCount > 0 ? "需先移出全部茶品" : "删除品牌"}
                  className="px-3 py-1.5 text-xs border border-stone-200 text-stone-400 rounded-lg hover:border-red-300 hover:text-red-600 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                >
                  删除
                </button>
              </div>

              {/* 资料编辑（改名/描述） */}
              {editId === b.id && (
                <div className="mt-3 border-t border-stone-100 pt-3 flex flex-wrap items-center gap-2">
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="品牌名"
                    className="px-2 py-1 text-xs border border-stone-200 rounded w-32"
                  />
                  <input
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    placeholder="品牌简介（可选，如：勐海茶厂旗下主品牌）"
                    className="px-2 py-1 text-xs border border-stone-200 rounded flex-1 min-w-48"
                  />
                  <button
                    onClick={() => saveBrand(b, editName, editDesc)}
                    className="px-3 py-1 text-xs bg-amber-800 text-white rounded hover:bg-amber-900 transition"
                  >
                    保存（同步茶品与吧）
                  </button>
                </div>
              )}

              {/* 茶品归属管理（展开） */}
              {openId === b.id && (
                <div className="mt-3 border-t border-stone-100 pt-3 space-y-3">
                  <div>
                    <input
                      value={teaSearch}
                      onChange={(e) => setTeaSearch(e.target.value)}
                      placeholder="搜索茶品加入该品牌（支持 品牌 茶名）…"
                      className="w-full px-3 py-1.5 text-xs border border-stone-200 rounded-lg focus:border-amber-500 outline-none"
                    />
                    {candidates.length > 0 && (
                      <div className="mt-1.5 border border-stone-200 rounded-lg divide-y divide-stone-100 max-h-56 overflow-y-auto">
                        {candidates.map((t) => (
                          <div key={t.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-stone-50">
                            <div className="flex-1 min-w-0">
                              <span className="text-xs text-stone-700 truncate block">
                                {t.brand} · {t.name}
                              </span>
                              <span className="text-[0.65rem] text-stone-400">
                                {t.year} · {t.type === "raw" ? "生茶" : "熟茶"} · {t._count?.tastingNotes ?? t.tastingNoteCount} 篇
                              </span>
                            </div>
                            <button
                              onClick={() => addTeas(b.id, [t.id])}
                              className="px-2 py-1 text-xs bg-stone-700 text-white rounded hover:bg-stone-800 transition shrink-0"
                            >
                              + 划入
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="space-y-1">
                    {brandTeas.length === 0 && <p className="text-xs text-stone-400">该品牌暂无茶品</p>}
                    {brandTeas.slice(0, 100).map((t) => (
                      <div key={t.id} className="flex items-center gap-2 bg-stone-50 rounded-lg px-2.5 py-1.5">
                        <Link href={`/tea/${t.id}`} target="_blank" className="flex-1 min-w-0 text-xs text-stone-700 hover:text-amber-700 truncate">
                          {t.name}
                          {t.isClassic && <span className="ml-1 text-amber-700">🏵️</span>}
                        </Link>
                        <span className="text-[0.65rem] text-stone-400 shrink-0">
                          {t.year} · {t._count?.tastingNotes ?? t.tastingNoteCount} 篇
                        </span>
                        <button
                          onClick={() => removeTea(b.id, t.id)}
                          className="px-2 py-0.5 text-xs border border-stone-300 text-stone-500 rounded hover:border-red-300 hover:text-red-600 transition shrink-0"
                        >
                          移出
                        </button>
                      </div>
                    ))}
                    {brandTeas.length > 100 && (
                      <p className="text-[0.65rem] text-stone-400">仅显示前 100 款，共 {brandTeas.length} 款</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
          {filteredBrands.length === 0 && (
            <p className="text-stone-400 text-sm py-8 text-center">没有符合条件的品牌</p>
          )}
        </div>
      )}
    </div>
  );
}
