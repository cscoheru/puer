"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

/**
 * 新增茶品表单（客户端）。
 *
 * 准入判定在**服务端**（`/encyclopedia/new/page.tsx`）：只有管理员与站长能进来。
 * 这里只负责表单交互 —— 别再在这里做权限判断（`level >= 2` 那套已经废止：
 * 它意味着任何 Lv.2 爱茶人都能建茶品，2026-11-02 收紧掉了）。
 */
export default function NewTeaForm({
  allowClassic,
  defaultClassic = false,
}: {
  /** 能不能直接「发布为经典」（管理员与站长）。 */
  allowClassic: boolean;
  /** 从 ?classic=1 深链进来时预勾选。 */
  defaultClassic?: boolean;
}) {
  const router = useRouter();
  const [isClassic, setIsClassic] = useState(allowClassic && defaultClassic);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");

    const form = e.target as HTMLFormElement;
    const el = (n: string) => form.elements.namedItem(n) as unknown as HTMLInputElement;
    const data = {
      name: el("name").value.trim(),
      brand: el("brand").value.trim(),
      year: parseInt(el("year").value),
      type: (form.elements.namedItem("type") as unknown as HTMLSelectElement).value,
      batch: el("batch").value.trim() || undefined,
      originRegion: el("originRegion").value.trim() || undefined,
      weightSpec: el("weightSpec").value.trim() || undefined,
      storageCondition: el("storageCondition").value.trim() || undefined,
      coverImage: el("coverImage").value.trim() || undefined,
      description: (form.elements.namedItem("description") as unknown as HTMLTextAreaElement).value.trim() || undefined,
      // 「是否经典」由**服务端**再判一次权限（前端说是经典不算数）
      isClassic: isClassic || undefined,
    };

    try {
      const res = await fetch("/api/teas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "创建失败");
      }
      const tea = await res.json();
      router.push(`/tea/${tea.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-10">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/encyclopedia" className="hover:text-amber-700 transition">茶品百科</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">新增茶品</span>
      </nav>

      <h1 className="text-2xl md:text-3xl font-serif font-bold text-stone-800 mb-6">新增茶品</h1>

      <form onSubmit={handleSubmit} className="space-y-5">
        {allowClassic && (
          <label className="flex items-center gap-2.5 p-3 bg-amber-50 border border-amber-200 rounded-lg cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isClassic}
              onChange={(e) => setIsClassic(e.target.checked)}
              className="w-4 h-4 accent-amber-700"
            />
            <span className="text-sm text-stone-700">
              🏵️ 入选<strong className="text-amber-800">经典普洱吧</strong>
              <span className="text-xs text-stone-400 ml-1.5">创建后茶品将出现在经典普洱品牌吧，茶友可在档案页跟进</span>
            </span>
          </label>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">茶品名称 *</label>
            <input name="name" required maxLength={200} placeholder="如: 7542" className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">品牌 *</label>
            <input name="brand" required maxLength={100} placeholder="如: 大益" className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">年份 *</label>
            <input name="year" type="number" required min={1900} max={2100} placeholder="如: 2005" className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">茶类 *</label>
            <select name="type" required defaultValue="" className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500">
              <option value="" disabled>选择茶类</option>
              <option value="raw">生茶</option>
              <option value="ripe">熟茶</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">批次</label>
            <input name="batch" maxLength={50} placeholder="如: 208" className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">产地</label>
            <input name="originRegion" maxLength={100} placeholder="如: 勐海" className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">规格</label>
            <input name="weightSpec" maxLength={50} placeholder="如: 357g/饼" className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">仓储</label>
            <input name="storageCondition" maxLength={100} placeholder="如: 昆明干仓" className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500" />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">封面图片 URL</label>
          <input name="coverImage" placeholder="https://..." className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500" />
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">简介</label>
          <textarea name="description" rows={4} placeholder="茶品背景、历史、特点..." className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500 resize-y" />
        </div>

        {error && <p className="text-red-600 text-sm">{error}</p>}

        <div className="flex items-center gap-3">
          <button type="submit" disabled={submitting} className="px-6 py-3 bg-amber-800 text-white rounded-lg text-sm font-medium hover:bg-amber-900 disabled:opacity-50 transition min-h-[44px]">
            {submitting ? "提交中..." : "创建茶品"}
          </button>
          <Link href="/encyclopedia" className="text-sm text-stone-500 hover:text-stone-700 transition">
            取消
          </Link>
        </div>
      </form>
    </div>
  );
}
