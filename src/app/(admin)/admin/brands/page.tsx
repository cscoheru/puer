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

// R20 品牌内茶品分页大小（未知品牌上千款也能翻页处理完）
const OWNED_PAGE_SIZE = 100;

export default function AdminBrandsPage() {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [teas, setTeas] = useState<Tea[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  // 展开的品牌 id -> 本品牌内茶品搜索词 + 分页
  const [openId, setOpenId] = useState<string | null>(null);
  const [teaSearch, setTeaSearch] = useState("");
  const [ownedPage, setOwnedPage] = useState(1);
  // 编辑中的品牌 id + 表单
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [newBrandName, setNewBrandName] = useState("");
  // R20 批量选择：品牌内茶品勾选（搜索结果可全选/取消全选）/ 移出目标品牌 id（"" = 未知）
  const [selOwned, setSelOwned] = useState<string[]>([]);
  const [moveOutTarget, setMoveOutTarget] = useState("");

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

  // 该品牌下的茶品（R20：跨品牌「移入」入口已移除——归属调整统一在茶品现属
  // 品牌侧「移出到其他品牌」完成，避免双向入口搞乱归属）
  const brandTeas = useMemo(
    () => (openBrand ? teas.filter((t) => t.brand === openBrand.name) : []),
    [teas, openBrand],
  );

  // R20 本品牌内搜索（茶名/年份）——搜索结果支持全选/取消全选，配合分页
  // 可处理「未知」上千款的大品牌
  const brandTeasFiltered = useMemo(() => {
    const q = teaSearch.trim().toLowerCase();
    if (!q) return brandTeas;
    return brandTeas.filter((t) => t.name.toLowerCase().includes(q) || String(t.year).includes(q));
  }, [brandTeas, teaSearch]);

  const ownedTotalPages = Math.max(1, Math.ceil(brandTeasFiltered.length / OWNED_PAGE_SIZE));
  const ownedPageSafe = Math.min(ownedPage, ownedTotalPages);
  const pagedBrandTeas = brandTeasFiltered.slice((ownedPageSafe - 1) * OWNED_PAGE_SIZE, ownedPageSafe * OWNED_PAGE_SIZE);

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
      setMessage(`✓ 已创建品牌「${name}」，展开后可管理茶品`);
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

  async function removeTeas(brandId: string, teaIds: string[], toBrandId?: string) {
    const target = toBrandId ? brands.find((b) => b.id === toBrandId)?.name : "未知";
    if (!confirm(`移出 ${teaIds.length} 款茶品到「${target}」？`)) return;
    const res = await fetch("/api/admin/brands/teas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brandId, removeTeaIds: teaIds, ...(toBrandId ? { toBrandId } : {}) }),
    });
    if (res.ok) {
      setMessage(`✓ 已移出 ${teaIds.length} 款茶品到「${target}」`);
      setSelOwned([]);
      setMoveOutTarget("");
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
                  onClick={() => { setOpenId(openId === b.id ? null : b.id); setTeaSearch(""); setOwnedPage(1); setSelOwned([]); setMoveOutTarget(""); }}
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
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        value={teaSearch}
                        onChange={(e) => { setTeaSearch(e.target.value); setOwnedPage(1); }}
                        placeholder={`搜索本品牌茶品（共 ${brandTeas.length} 款，支持茶名/年份）…`}
                        className="flex-1 min-w-56 px-3 py-1.5 text-xs border border-stone-200 rounded-lg focus:border-amber-500 outline-none"
                      />
                      <button
                        onClick={() =>
                          setSelOwned((prev) =>
                            prev.length === brandTeasFiltered.length ? [] : brandTeasFiltered.map((t) => t.id),
                          )
                        }
                        disabled={brandTeasFiltered.length === 0}
                        className="px-2 py-1 text-[0.65rem] border border-amber-300 text-amber-800 rounded hover:bg-amber-100 disabled:opacity-40 shrink-0"
                      >
                        {selOwned.length === brandTeasFiltered.length && brandTeasFiltered.length > 0 ? "取消全选" : `全选结果（${brandTeasFiltered.length}）`}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1">
                    {brandTeas.length === 0 && <p className="text-xs text-stone-400">该品牌暂无茶品</p>}

                    {/* 批量移出操作条（有勾选时显示） */}
                    {selOwned.length > 0 && (
                      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
                        <span className="text-xs text-amber-800 font-medium">已勾选 {selOwned.length} 款</span>
                        <select
                          value={moveOutTarget}
                          onChange={(e) => setMoveOutTarget(e.target.value)}
                          className="px-2 py-1 text-xs border border-amber-300 rounded bg-white focus:outline-none"
                        >
                          <option value="">移出到：未知</option>
                          {brands
                            .filter((tb) => tb.id !== b.id)
                            .map((tb) => (
                              <option key={tb.id} value={tb.id}>
                                移出到：{tb.name}（{tb.teaCount} 款）
                              </option>
                            ))}
                        </select>
                        <button
                          onClick={() => removeTeas(b.id, selOwned, moveOutTarget || undefined)}
                          className="px-2.5 py-1 text-xs bg-amber-800 text-white rounded hover:bg-amber-900 font-medium"
                        >
                          ⇨ 批量移出 ({selOwned.length})
                        </button>
                        <button
                          onClick={() => setSelOwned([])}
                          className="px-2 py-1 text-[0.65rem] border border-amber-300 text-amber-800 rounded hover:bg-amber-100"
                        >
                          清空勾选
                        </button>
                      </div>
                    )}

                    <div className="flex items-center gap-2 px-1">
                      <span className="text-[0.65rem] text-stone-400">
                        {teaSearch.trim()
                          ? `搜索结果 ${brandTeasFiltered.length} / ${brandTeas.length} 款，已勾选 ${selOwned.length} 款`
                          : `共 ${brandTeas.length} 款，已勾选 ${selOwned.length} 款；勾选后可批量移出到其他品牌`}
                      </span>
                    </div>

                    {pagedBrandTeas.map((t) => (
                      <label key={t.id} className="flex items-center gap-2 bg-stone-50 rounded-lg px-2.5 py-1.5 cursor-pointer hover:bg-stone-100 transition">
                        <input
                          type="checkbox"
                          checked={selOwned.includes(t.id)}
                          onChange={(e) =>
                            setSelOwned((prev) => (e.target.checked ? [...prev, t.id] : prev.filter((id) => id !== t.id)))
                          }
                          className="accent-amber-800 shrink-0"
                        />
                        <Link href={`/tea/${t.id}`} target="_blank" onClick={(e) => e.stopPropagation()} className="flex-1 min-w-0 text-xs text-stone-700 hover:text-amber-700 truncate">
                          {t.name}
                          {t.isClassic && <span className="ml-1 text-amber-700">🏵️</span>}
                        </Link>
                        <span className="text-[0.65rem] text-stone-400 shrink-0">
                          {t.year} · {t._count?.tastingNotes ?? t.tastingNoteCount} 篇
                        </span>
                      </label>
                    ))}
                    {brandTeasFiltered.length === 0 && brandTeas.length > 0 && (
                      <p className="text-[0.65rem] text-stone-400">本品牌内无匹配「{teaSearch.trim()}」的茶品</p>
                    )}

                    {/* R20 分页：大品牌（如未知上千款）翻页处理，勾选跨页保留 */}
                    {ownedTotalPages > 1 && (
                      <div className="flex items-center justify-center gap-3 pt-1">
                        <button
                          onClick={() => setOwnedPage((p) => Math.max(1, p - 1))}
                          disabled={ownedPageSafe <= 1}
                          className="px-2.5 py-1 text-xs border border-stone-200 text-stone-600 rounded hover:border-amber-400 disabled:opacity-40"
                        >
                          ‹ 上一页
                        </button>
                        <span className="text-[0.65rem] text-stone-500">
                          第 {ownedPageSafe} / {ownedTotalPages} 页 · 每页 {OWNED_PAGE_SIZE} 款
                        </span>
                        <button
                          onClick={() => setOwnedPage((p) => Math.min(ownedTotalPages, p + 1))}
                          disabled={ownedPageSafe >= ownedTotalPages}
                          className="px-2.5 py-1 text-xs border border-stone-200 text-stone-600 rounded hover:border-amber-400 disabled:opacity-40"
                        >
                          下一页 ›
                        </button>
                      </div>
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
