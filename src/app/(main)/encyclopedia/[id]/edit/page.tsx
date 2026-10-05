"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";

export default function EditTeaPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // form fields
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [year, setYear] = useState("");
  const [type, setType] = useState("raw");
  const [batch, setBatch] = useState("");
  const [originRegion, setOriginRegion] = useState("");
  const [weightSpec, setWeightSpec] = useState("");
  const [coverImage, setCoverImage] = useState("");
  const [description, setDescription] = useState("");
  const [marketText, setMarketText] = useState("");

  const isEligible = status === "authenticated" && session.user.level >= 2;

  // Load existing tea data
  useEffect(() => {
    if (status !== "authenticated" || !isEligible) return;
    fetch(`/api/teas/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error("茶品不存在");
        return res.json();
      })
      .then((tea) => {
        setName(tea.name ?? "");
        setBrand(tea.brand ?? "");
        setYear(tea.year ? String(tea.year) : "");
        setType(tea.type ?? "raw");
        setBatch(tea.batch ?? "");
        setOriginRegion(tea.originRegion ?? "");
        setWeightSpec(tea.weightSpec ?? "");
        setCoverImage(tea.coverImage ?? "");
        setDescription(tea.description ?? "");
        // marketInfo is a JSON blob; extract the price text for editing
        if (tea.marketInfo && typeof tea.marketInfo === "object" && typeof tea.marketInfo.price === "string") {
          setMarketText(tea.marketInfo.price);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "加载失败"))
      .finally(() => setLoading(false));
  }, [id, status, isEligible]);

  if (status === "loading" || loading) {
    return <div className="text-center py-12 text-stone-400">加载中...</div>;
  }

  if (status === "unauthenticated" || !isEligible) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 text-center">
        <p className="text-stone-500 mb-2">需要 Lv.2 茶人及以上才能编辑茶品百科</p>
        <Link href={`/tea/${id}`} className="inline-block border border-stone-300 text-stone-600 px-5 py-2.5 rounded-lg text-sm hover:border-amber-300 transition">
          返回茶品
        </Link>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");

    const data: Record<string, unknown> = {
      name: name.trim(),
      brand: brand.trim(),
      year: parseInt(year),
      type,
      batch: batch.trim() || undefined,
      originRegion: originRegion.trim() || undefined,
      weightSpec: weightSpec.trim() || undefined,
      coverImage: coverImage.trim() || undefined,
      description: description.trim() || undefined,
    };

    // Include marketInfo only if user entered something
    if (marketText.trim()) {
      data.marketInfo = {
        price: marketText.trim(),
        updatedAt: new Date().toISOString(),
      };
    } else {
      data.marketInfo = null;
    }

    try {
      const res = await fetch(`/api/teas/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "保存失败");
      }
      router.push(`/tea/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-10">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/encyclopedia" className="hover:text-amber-700 transition">茶品百科</Link>
        <span className="mx-2">/</span>
        <Link href={`/tea/${id}`} className="hover:text-amber-700 transition">茶品详情</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">编辑</span>
      </nav>

      <h1 className="text-2xl md:text-3xl font-serif font-bold text-stone-800 mb-6">编辑茶品</h1>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">茶品名称 *</label>
            <input
              name="name"
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如: 7542"
              className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">品牌 *</label>
            <input
              name="brand"
              required
              maxLength={100}
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="如: 大益"
              className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">年份 *</label>
            <input
              name="year"
              type="number"
              required
              min={1900}
              max={2100}
              value={year}
              onChange={(e) => setYear(e.target.value)}
              placeholder="如: 2005"
              className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">茶类 *</label>
            <select
              name="type"
              required
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
            >
              <option value="raw">生茶</option>
              <option value="ripe">熟茶</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">批次</label>
            <input
              name="batch"
              maxLength={50}
              value={batch}
              onChange={(e) => setBatch(e.target.value)}
              placeholder="如: 208"
              className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">产地</label>
            <input
              name="originRegion"
              maxLength={100}
              value={originRegion}
              onChange={(e) => setOriginRegion(e.target.value)}
              placeholder="如: 勐海"
              className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">规格</label>
            <input
              name="weightSpec"
              maxLength={50}
              value={weightSpec}
              onChange={(e) => setWeightSpec(e.target.value)}
              placeholder="如: 357g/饼"
              className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">封面图片 URL</label>
          <input
            name="coverImage"
            value={coverImage}
            onChange={(e) => setCoverImage(e.target.value)}
            placeholder="https://..."
            className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
          />
          {coverImage && (
            <img src={coverImage} alt="封面预览" className="mt-2 max-h-40 rounded-lg object-cover border border-stone-200" />
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">行情估价</label>
          <input
            name="marketText"
            value={marketText}
            onChange={(e) => setMarketText(e.target.value)}
            placeholder="如: ¥38,000/件 ▲ 5.2% 来源：东和行情"
            className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
          />
          <p className="text-xs text-stone-400 mt-1">填写当前行情价格，将显示在茶品详情页</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">简介</label>
          <textarea
            name="description"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="茶品背景、历史、特点..."
            className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500 resize-y"
          />
        </div>

        {error && <p className="text-red-600 text-sm">{error}</p>}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-3 bg-amber-800 text-white rounded-lg text-sm font-medium hover:bg-amber-900 disabled:opacity-50 transition min-h-[44px]"
          >
            {submitting ? "保存中..." : "保存修改"}
          </button>
          <Link href={`/tea/${id}`} className="text-sm text-stone-500 hover:text-stone-700 transition">
            取消
          </Link>
        </div>
      </form>
    </div>
  );
}