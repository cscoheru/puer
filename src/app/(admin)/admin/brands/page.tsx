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

// P2-R21 删除箱条目
interface TrashTea {
  id: string;
  name: string;
  brand: string;
  year: number;
  type: string;
  deletedAt: string;
  tastingNoteCount: number;
  _count: { tastingNotes: number; articles: number; teaSessions: number };
}

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
  // P2-R21 删除箱
  const [showTrash, setShowTrash] = useState(false);
  const [trashTeas, setTrashTeas] = useState<TrashTea[]>([]);
  const [selTrash, setSelTrash] = useState<string[]>([]);

  async function loadTrash() {
    const res = await fetch("/api/admin/brands/trash").catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    setTrashTeas(data.teas || []);
  }

  async function reload() {
    const [b, t] = await Promise.all([
      fetch("/api/admin/brands").then((r) => r.json()).catch(() => ({ brands: [] })),
      fetch("/api/teas?limit=9999").then((r) => r.json()).catch(() => ({ teas: [] })),
    ]);
    setBrands(b.brands || []);
    setTeas(t.teas || []);
    await loadTrash();
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

  // P2-R21 软删除：移入删除箱（可还原/彻底删除）
  async function deleteTeas(brandId: string, teaIds: string[]) {
    if (!confirm(`将 ${teaIds.length} 款茶品移入删除箱？\n删除后前台不再展示，可在删除箱中还原或彻底删除。`)) return;
    const res = await fetch("/api/admin/brands/teas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brandId, deleteTeaIds: teaIds }),
    });
    if (res.ok) {
      setMessage(`🗑 已将 ${teaIds.length} 款茶品移入删除箱（可还原或彻底删除）`);
      setSelOwned([]);
      await reload();
    } else {
      const err = await res.json().catch(() => ({}));
      setMessage(err.error || "操作失败");
    }
  }

  async function restoreTeas(teaIds: string[]) {
    const res = await fetch("/api/admin/brands/trash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore", teaIds }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setMessage(`✓ 已还原 ${data.restored ?? 0} 款茶品到原品牌`);
      setSelTrash((s) => s.filter((id) => !teaIds.includes(id)));
      await reload();
    } else {
      setMessage(data.error || "还原失败");
    }
  }

  async function purgeTeas(teaIds: string[]) {
    if (!confirm(`彻底删除 ${teaIds.length} 款茶品？此操作不可恢复！`)) return;
    const res = await fetch("/api/admin/brands/trash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "purge", teaIds }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const blockedMsg =
        data.blocked?.length > 0
          ? `；${data.blocked.length} 款因关联笔记/帖子/茶会被跳过（先在合并工具处理内容）`
          : "";
      setMessage(`🔥 已彻底删除 ${data.purged ?? 0} 款茶品${blockedMsg}`);
      setSelTrash((s) => s.filter((id) => !teaIds.includes(id)));
      await loadTrash();
    } else {
      setMessage(data.error || "删除失败");
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
        <button
          onClick={() => { setShowTrash((v) => !v); if (!showTrash) loadTrash(); }}
          className="px-3 py-1.5 text-sm border border-stone-300 text-stone-600 rounded-lg hover:border-red-400 hover:text-red-700 transition whitespace-nowrap"
        >
          🗑 删除箱{trashTeas.length > 0 ? `（${trashTeas.length}）` : ""}
        </button>
      </div>

      {message && (
        <p className="mb-4 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">{message}</p>
      )}

      {/* P2-R21 删除箱面板 */}
      {showTrash && (
        <div className="mb-6 bg-white border border-red-200 rounded-xl p-4">
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <span className="font-medium text-sm text-red-800">🗑 删除箱（{trashTeas.length}）</span>
            <span className="text-xs text-stone-400">茶品删除后先进此处；可还原回原品牌，或彻底删除（不可恢复）</span>
            <div className="flex-1" />
            {trashTeas.length > 0 && (
              <>
                <button
                  onClick={() => setSelTrash(selTrash.length === trashTeas.length ? [] : trashTeas.map((t) => t.id))}
                  className="px-2.5 py-1 text-xs border border-stone-200 text-stone-600 rounded-lg hover:border-stone-400 transition"
                >
                  {selTrash.length === trashTeas.length ? "取消全选" : "全选"}
                </button>
                <button
                  onClick={() => selTrash.length > 0 && restoreTeas(selTrash)}
                  disabled={selTrash.length === 0}
                  className="px-2.5 py-1 text-xs border border-emerald-300 text-emerald-700 rounded-lg hover:bg-emerald-50 transition disabled:opacity-40"
                >
                  ↩ 还原 ({selTrash.length})
                </button>
                <button
                  onClick={() => selTrash.length > 0 && purgeTeas(selTrash)}
                  disabled={selTrash.length === 0}
                  className="px-2.5 py-1 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700 transition disabled:opacity-40"
                >
                  🔥 彻底删除 ({selTrash.length})
                </button>
              </>
            )}
          </div>
          {trashTeas.length === 0 ? (
            <p className="text-sm text-stone-400 py-4 text-center">删除箱是空的</p>
          ) : (
            <ul className="divide-y divide-stone-100 max-h-72 overflow-y-auto">
              {trashTeas.map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selTrash.includes(t.id)}
                    onChange={(e) => setSelTrash(e.target.checked ? [...selTrash, t.id] : selTrash.filter((x) => x !== t.id))}
                    className="accent-red-600"
                  />
                  <span className="font-medium text-stone-800 flex-1 min-w-0 truncate">
                    {t.name}
                    <span className="text-xs text-stone-400 ml-2">
                      {t.brand || "未知"} · {t.year || "?"} · {t.type === "raw" ? "生" : "熟"}
                      {t._count.tastingNotes > 0 || t._count.articles > 0 || t._count.teaSessions > 0
                        ? ` · ⚠ 笔记${t._count.tastingNotes}/帖子${t._count.articles}/茶会${t._count.teaSessions}（不可彻底删）`
                        : ""}
                    </span>
                  </span>
                  <span className="text-xs text-stone-400 whitespace-nowrap">
                    {t.deletedAt ? new Date(t.deletedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
                  </span>
                  <button
                    onClick={() => restoreTeas([t.id])}
                    className="px-2 py-0.5 text-xs border border-emerald-300 text-emerald-700 rounded hover:bg-emerald-50 transition whitespace-nowrap"
                  >
                    ↩ 还原
                  </button>
                  <button
                    onClick={() => purgeTeas([t.id])}
                    className="px-2 py-0.5 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50 transition whitespace-nowrap"
                  >
                    🔥 彻底删除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
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
                          onClick={() => deleteTeas(b.id, selOwned)}
                          className="px-2.5 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 font-medium"
                        >
                          🗑 移入删除箱 ({selOwned.length})
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
