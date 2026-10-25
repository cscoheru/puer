"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";

import { cleanTeaName, sortTeasForMerge } from "@/lib/tea-name-clean";

interface Tea {
  id: string;
  name: string;
  brand: string;
  year: number;
  type: string;
  isClassic: boolean;
  /** 待整理：还没被站长整理过的茶品素材（只有站长看得见）。 */
  needsReview: boolean;
  tastingNoteCount: number;
  _count?: { tastingNotes: number };
}

/** 回收站里的茶品。 */
interface TrashTea {
  id: string;
  name: string;
  displayName: string;
  brand: string;
  year: number;
  deletedAt: string | null;
  refs: number;
  tastingNotes: number;
  articles: number;
  cellarItems: number;
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
  // 只看「待整理」层（站长要整理的那些）
  const [onlyPending, setOnlyPending] = useState(false);
  // 勾选待合并的茶品 id + 保留主体 id
  const [selected, setSelected] = useState<string[]>([]);
  const [keepId, setKeepId] = useState<string>("");
  // 回收站
  const [trash, setTrash] = useState<TrashTea[]>([]);
  const [showTrash, setShowTrash] = useState(false);

  const loadTrash = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/teas/trash");
      if (!res.ok) return;
      const data = await res.json();
      setTrash(Array.isArray(data.teas) ? data.teas : []);
    } catch {
      setTrash([]);
    }
  }, []);

  const reloadTeas = useCallback(() => {
    return fetch("/api/teas?limit=9999&includePending=1")
      .then((r) => r.json())
      .then((data) => setTeas(data.teas || []))
      .catch(() => setMessage("加载失败"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void reloadTeas();
  }, [reloadTeas]);

  // 勾选中的那些茶（批量合并 / 批量回收站都要用）
  const selectedTeas = useMemo(
    () => selected.map((id) => teas.find((t) => t.id === id)).filter(Boolean) as Tea[],
    [selected, teas],
  );

  // 品牌分组（按茶品数降序）
  const brandGroups = useMemo(() => {
    const m = new Map<string, Tea[]>();
    for (const t of teas) {
      // 「只看待整理」时只留待整理的茶品
      if (onlyPending && !t.needsReview) continue;
      const list = m.get(t.brand) || [];
      list.push(t);
      m.set(t.brand, list);
    }
    return [...m.entries()]
      .map(([name, list]) => ({ name, list }))
      .sort((a, b) => b.list.length - a.list.length || a.name.localeCompare(b.name, "zh"));
  }, [teas, onlyPending]);

  /** 当前筛选下的全部茶品（「只看待整理」时只留待整理的）。 */
  const allTeas = useMemo(
    () => (onlyPending ? teas.filter((t) => t.needsReview) : teas),
    [teas, onlyPending],
  );

  const pendingCount = useMemo(
    () => teas.filter((t) => t.needsReview).length,
    [teas],
  );

  /**
   * 当前要操作的茶品集合。
   *
   * 品牌选「全部」时是**全库**（站长 2026-10-24 要求的：不用先选品牌就能
   * 看到所有茶品并合并）。选具体品牌时是那个品牌。
   */
  const activeGroup = useMemo(() => {
    if (brand === "") {
      // 全部：按拼音排（名字多以年份开头 → 年份自然聚成一段，同年里
      // 拼音序 → 相同/相近的名字挨着，便于合并）
      return { name: "全部", list: sortTeasForMerge(allTeas) };
    }
    return brandGroups.find((g) => g.name === brand) || null;
  }, [brandGroups, brand, allTeas]);

  // 可见茶品（筛选词）；按拼音排序，便于把相同/相近的名字排在一起
  const visible = useMemo(() => {
    if (!activeGroup) return [];
    const list = sortTeasForMerge(activeGroup.list);
    if (!filter.trim()) return list;
    const q = filter.trim().toLowerCase();
    return list.filter(
      (t) =>
        cleanTeaName(t.name).toLowerCase().includes(q) ||
        String(t.year).includes(q),
    );
  }, [activeGroup, filter]);

  // 疑似重复：先列**完全同名**的（那些能一键合并），再列相似度达标的。
  // 品牌内 n²，未知品牌 1257 款 ≈79 万次比较，可接受。
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
    // 完全同名的排前面 —— 它们是可以直接合并的
    out.sort((a, b) => {
      const sameA = cleanTeaName(a[0].name) === cleanTeaName(a[1].name);
      const sameB = cleanTeaName(b[0].name) === cleanTeaName(b[1].name);
      if (sameA !== sameB) return sameA ? -1 : 1;
      return b[2] - a[2];
    });
    return out.slice(0, 50);
  }, [activeGroup, threshold]);

  /** 「完全同名」的两条 —— 可以一键合并（方向由服务器定：笔记少的并入多的）。 */
  const sameNamePairs = useMemo(
    () =>
      pairs.filter(
        ([a, b]) => cleanTeaName(a.name) === cleanTeaName(b.name),
      ),
    [pairs],
  );

  /** 移到回收站（软删除：行还在、笔记还在，误删了能捞回来）。 */
  async function moveToTrash(teaId: string, name: string) {
    if (!confirm(`把「${name}」移到回收站？\n它会从公开茶品库里消失（笔记还在，可以恢复）。`)) {
      return;
    }
    setMessage("处理中…");
    try {
      const res = await fetch("/api/admin/teas/trash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teaId, action: "trash" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error || "操作失败");
        return;
      }
      setTeas((prev) => prev.filter((t) => t.id !== teaId));
      setSelected((prev) => prev.filter((id) => id !== teaId));
      setMessage(`「${name}」已移到回收站`);
      loadTrash();
    } catch {
      setMessage("操作失败");
    }
  }

  /**
   * 把选中的多款**一次性**移进回收站。
   *
   * 站长 2026-10-25：「回收站要做到多选后集中放入回收站（现在是一对一）」。
   * 软删除：行还在、笔记还在，误删了能捞回来。
   */
  async function moveSelectedToTrash() {
    if (selected.length === 0) return;
    const names = selectedTeas
      .map((t) => t.name)
      .slice(0, 5)
      .join("、");
    if (
      !confirm(
        `把选中的 ${selected.length} 款移进回收站？\n` +
          `（${names}${selected.length > 5 ? " 等" : ""}）\n` +
          `它们会从公开茶品库里消失 —— 笔记还在，可以恢复。`,
      )
    ) {
      return;
    }
    setMessage("处理中…");
    try {
      const res = await fetch("/api/admin/teas/trash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teaIds: selected, action: "trash" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error || "操作失败");
        return;
      }
      const moved = selected.length;
      setTeas((prev) => prev.filter((t) => !selected.includes(t.id)));
      setSelected([]);
      setKeepId("");
      setMessage(`已把 ${data.trashed ?? moved} 款移进回收站。`);
      loadTrash();
    } catch {
      setMessage("操作失败");
    }
  }

  /**
   * 一键合并所有「名称 + 年份 + 品牌」全同的茶品。
   *
   * 站长 2026-10-25：「对于茶品名称完全一样的，请在系统中直接进行合并，
   * 不需要手动操作。」
   *
   * 先出报告（dry-run）给他看数量与样例，确认后才真并 —— 合并是**删行**
   * 的操作，不能一按就发生。
   */
  async function mergeAllSameName(dryRun: boolean) {
    setMessage(dryRun ? "统计中…" : "合并中…");
    try {
      const res = await fetch("/api/admin/teas/merge-same-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true, dryRun }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error || "操作失败");
        return;
      }
      if (dryRun) {
        setMessage(
          `同名同年份同品牌的茶品：${data.groups} 组，多余 ${data.redundant} 条。` +
            `确认后点「一键合并」执行。`,
        );
        return;
      }
      setMessage(
        `已合并 ${data.merged} 组${data.errors?.length ? `，${data.errors.length} 组失败` : ""}。` +
          `（笔记/帖子/茶仓条目都已转到保留的那条上。）`,
      );
      await reloadTeas();
      loadTrash();    } catch {
      setMessage("操作失败");
    }
  }

  /** 从回收站恢复。 */
  async function restoreTea(teaId: string, name: string) {
    setMessage("处理中…");
    try {
      const res = await fetch("/api/admin/teas/trash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teaId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error || "操作失败");
        return;
      }
      setMessage(`「${name}」已恢复`);
      loadTrash();
    } catch {
      setMessage("操作失败");
    }
  }

  /** 彻底删除。 */
  async function purgeTea(teaId: string, name: string) {
    if (
      !confirm(
        `彻底删除「${name}」？\n` +
          "**删掉就找不回来了。**\n" +
          "（挂着笔记的茶品不会被允许删 —— 请先合并到别的茶品上。）",
      )
    ) {
      return;
    }
    setMessage("处理中…");
    try {
      const res = await fetch("/api/admin/teas/trash", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teaId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error || "操作失败");
        return;
      }
      setMessage(`「${name}」已彻底删除`);
      loadTrash();
    } catch {
      setMessage("操作失败");
    }
  }

  /**
   * 一键合并**完全同名**的两款。
   *
   * 方向由服务器定（笔记少的并入多的）—— 客户端只负责说「这两条合并」。
   */
  async function mergeSameName(a: Tea, b: Tea) {
    if (!confirm(`合并「${cleanTeaName(a.name)}」的两条？\n笔记少的那条会并入笔记多的。`)) {
      return;
    }
    setMessage("合并中…");
    try {
      const res = await fetch("/api/admin/teas/merge-same-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idA: a.id, idB: b.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error || "合并失败");
        return;
      }
      setMessage(
        `已合并：保留「${data.keepName}」，「${data.removedName}」并入。`,
      );
      setTeas((prev) => prev.filter((t) => t.id !== data.removedId));
      setSelected([]);
      setKeepId("");
    } catch {
      setMessage("合并失败");
    }
  }

  /** 把茶品移进/移出「待整理」层。 */
  async function curate(teaId: string, needsReview: boolean) {
    setMessage("处理中…");
    try {
      const res = await fetch("/api/admin/teas/curate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teaId, needsReview }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error || "操作失败");
        return;
      }
      setTeas((prev) =>
        prev.map((t) => (t.id === teaId ? { ...t, needsReview } : t)),
      );
      setMessage(needsReview ? "已退回待整理" : "已整理，进入普通层");
    } catch {
      setMessage("操作失败");
    }
  }

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

      <h1 className="text-2xl font-serif font-bold text-stone-800 mb-2">茶品合并</h1>
      <p className="text-sm text-stone-500 mb-6">
        选「全部」或某个品牌 → 勾选多款疑似重复 → 指定保留主体（⭐）→ 批量合并。
        同名的两直接点「一键合并」（笔记少的并入多的）。共 {teas.length} 个茶品、{brandGroups.length} 个品牌。
        {pendingCount > 0 && (
          <span className="ml-2 text-amber-700">待整理 {pendingCount} 款（还没进公开库）</span>
        )}
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
              <option value="">全部（{allTeas.length} 款）</option>
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
            <button
              onClick={() => {
                setOnlyPending((v) => !v);
                setSelected([]);
                setKeepId("");
                setBrand("");
              }}
              className={`px-3 py-1.5 text-sm border rounded-lg transition ${
                onlyPending
                  ? "bg-amber-800 text-white border-amber-800"
                  : "bg-white text-stone-600 border-stone-200 hover:border-stone-300"
              }`}
            >
              只看待整理（{pendingCount}）
            </button>
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
                onClick={moveSelectedToTrash}
                className="px-3 py-1.5 text-xs border border-red-200 text-red-600 rounded-lg hover:bg-red-50 transition"
                title="把选中的这些一次性移进回收站（软删除，可恢复）"
              >
                🗑 放入回收站（{selected.length} 款）
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
                  <h2 className="text-sm font-medium text-stone-800">
                    {activeGroup.name} · {activeGroup.list.length} 款
                  </h2>
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
                          {cleanTeaName(t.name)}
                          {t.isClassic && <span className="ml-1 text-amber-700">🏵️</span>}
                          {t.needsReview && (
                            <span className="ml-1 text-[0.65rem] px-1 py-0.5 rounded bg-amber-100 text-amber-800">
                              待整理
                            </span>
                          )}
                        </Link>
                        <span className="text-[0.65rem] text-stone-400 shrink-0">
                          {t.year} · {t._count?.tastingNotes ?? t.tastingNoteCount} 篇
                        </span>
                        <button
                          onClick={() => moveToTrash(t.id, cleanTeaName(t.name))}
                          className="px-1.5 py-0.5 text-[0.65rem] text-stone-400 hover:text-red-600 hover:bg-red-50 rounded transition shrink-0"
                          title="移到回收站（软删除，可恢复）"
                        >
                          回收站
                        </button>
                        {t.needsReview && (
                          <button
                            onClick={() => curate(t.id, false)}
                            className="shrink-0 text-[0.65rem] text-amber-700 hover:underline"
                          >
                            整理好了
                          </button>
                        )}
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
                    <button
                      onClick={() => mergeAllSameName(true)}
                      className="ml-1 px-2 py-1 text-[0.65rem] border border-amber-300 text-amber-800 rounded hover:bg-amber-50 transition"
                      title="统计「名称 + 年份 + 品牌」全同的茶品有多少组"
                    >
                      统计同名
                    </button>
                    <button
                      onClick={() => {
                        if (
                          confirm(
                            "把所有「名称 + 年份 + 品牌」全同的茶品一次并掉？\n" +
                              "笔记、帖子、茶仓条目都会转到保留的那条上，被并掉的名字进别名。\n" +
                              "（先点「统计同名」看一眼数量更稳妥。）",
                          )
                        ) {
                          mergeAllSameName(false);
                        }
                      }}
                      className="px-2 py-1 text-[0.65rem] bg-amber-800 text-white rounded hover:bg-amber-900 transition"
                      title="一次性合并所有同名的茶品（方向由服务器定：经典优先、笔记多的留下）"
                    >
                      一键合并同名
                    </button>
                  </div>
                </div>
                <div className="max-h-[32rem] overflow-y-auto space-y-1.5">
                  {pairs.length === 0 && (
                    <p className="text-xs text-stone-400 py-4 text-center">未发现疑似重复</p>
                  )}
                  {sameNamePairs.length > 0 && (
                    <p className="text-[0.65rem] text-amber-700 pb-1">
                      其中 {sameNamePairs.length} 对**名称完全一样** —— 点「一键合并」即可
                      （笔记少的并入多的，方向由服务器定）。
                    </p>
                  )}
                  {pairs.map(([a, b, score], i) => (
                    <div key={i} className="flex items-center gap-2 border border-stone-100 rounded-lg px-2.5 py-1.5">
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-stone-700 truncate">{a.name} <span className="text-stone-300">vs</span> {b.name}</div>
                        <div className="text-[0.65rem] text-stone-400">
                          相似 {(score * 100).toFixed(0)}% · {a.year}/{b.year} · {(a._count?.tastingNotes ?? a.tastingNoteCount) + (b._count?.tastingNotes ?? b.tastingNoteCount)} 篇
                        </div>
                      </div>
                      {cleanTeaName(a.name) === cleanTeaName(b.name) ? (
                        <button
                          onClick={() => mergeSameName(a, b)}
                          className="px-2 py-1 text-[0.65rem] bg-amber-800 text-white rounded hover:bg-amber-900 shrink-0"
                          title="名称完全一样 —— 笔记少的那条直接并入笔记多的"
                        >
                          一键合并
                        </button>
                      ) : (
                        <button
                          onClick={() => pickPair(a.id, b.id)}
                          className="px-2 py-1 text-[0.65rem] border border-amber-300 text-amber-800 rounded hover:bg-amber-50 shrink-0"
                        >
                          勾选这对
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-stone-400 text-sm py-8 text-center">从上方选择一个品牌开始合并管理</p>
          )}

          {/* 回收站 */}
          <div className="mt-6 bg-white border border-stone-200 rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-medium text-stone-800">
                回收站（{trash.length}）
              </h2>
              <button
                onClick={() => {
                  const next = !showTrash;
                  setShowTrash(next);
                  if (next) loadTrash();
                }}
                className="px-3 py-1.5 text-sm border border-stone-200 rounded-lg text-stone-600 hover:border-stone-300 transition"
              >
                {showTrash ? "收起" : "展开"}
              </button>
            </div>
            {showTrash && (
              trash.length === 0 ? (
                <p className="text-xs text-stone-400 py-3 text-center">
                  回收站是空的
                </p>
              ) : (
                <div className="max-h-80 overflow-y-auto space-y-1">
                  {trash.map((t) => (
                    <div
                      key={t.id}
                      className="flex items-center gap-2 border border-stone-100 rounded-lg px-2.5 py-1.5"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-stone-700 truncate">
                          {t.displayName}
                        </div>
                        <div className="text-[0.65rem] text-stone-400">
                          {t.brand} {t.year} · 笔记 {t.tastingNotes} · 帖子{" "}
                          {t.articles} · 茶仓 {t.cellarItems}
                          {t.refs > 0 && (
                            <span className="text-amber-700">
                              　有内容，不能彻底删除
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => restoreTea(t.id, t.displayName)}
                        className="px-2 py-1 text-[0.65rem] border border-stone-200 text-stone-600 rounded hover:bg-stone-50 shrink-0"
                      >
                        恢复
                      </button>
                      <button
                        onClick={() => purgeTea(t.id, t.displayName)}
                        disabled={t.refs > 0}
                        className="px-2 py-1 text-[0.65rem] border border-red-200 text-red-600 rounded hover:bg-red-50 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                        title={
                          t.refs > 0
                            ? "还挂着内容 —— 先合并到别的茶品上"
                            : "彻底删除（找不回来了）"
                        }
                      >
                        彻底删除
                      </button>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}
