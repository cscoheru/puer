"use client";

import { useState } from "react";
import { uploadWithRetry } from "@/lib/upload-client";
import { TEA_TYPES, WEIGHT_SPECS, ACQUISITION_TYPES } from "./constants";

interface Props {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initial?: any;
  onClose: () => void;
  onSaved: () => void;
}

export default function TeaWishForm({ initial, onClose, onSaved }: Props) {
  const isEdit = !!initial;
  const [brand, setBrand] = useState((initial?.brand as string) || "");
  const [type, setType] = useState((initial?.type as string) || "");
  const [year, setYear] = useState(String(initial?.year ?? ""));
  const [spec, setSpec] = useState((initial?.spec as string) || "");
  const [acquisitionType, setAcquisitionType] = useState((initial?.acquisitionType as string) || "swap");

  // Swap offer fields
  const [swapOfferBrand, setSwapOfferBrand] = useState((initial?.swapOfferBrand as string) || "");
  const [swapOfferType, setSwapOfferType] = useState((initial?.swapOfferType as string) || "raw");
  const [swapOfferYear, setSwapOfferYear] = useState(String(initial?.swapOfferYear ?? ""));
  const [swapOfferSpec, setSwapOfferSpec] = useState((initial?.swapOfferSpec as string) || "357g");
  const [swapOfferWeight, setSwapOfferWeight] = useState(String(initial?.swapOfferWeight ?? ""));
  const [swapOfferDesc, setSwapOfferDesc] = useState((initial?.swapOfferDesc as string) || "");

  // Purchase price
  const [offerPrice, setOfferPrice] = useState(initial?.offerPrice ? String(initial.offerPrice) : "");

  const [description, setDescription] = useState((initial?.description as string) || "");
  const [images, setImages] = useState<string[]>((initial?.images as string[]) || []);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [error, setError] = useState("");

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    setError("");

    try {
      const results = await Promise.all(
        Array.from(files).map(async (file, i) => {
          setUploadProgress(`上传中 ${i + 1}/${files.length}...`);
          const res = await uploadWithRetry(file, undefined, 3, "inventory");
          return res.url;
        })
      );
      setImages((prev) => [...prev, ...results]);
    } catch {
      setError("图片上传失败，请重试");
    } finally {
      setUploading(false);
      setUploadProgress("");
      e.target.value = "";
    }
  }

  function removeImage(idx: number) {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);

    const body = {
      brand: brand || null, type: type || null, year: year ? parseInt(year, 10) : null, spec: spec || null,
      acquisitionType,
      swapOfferBrand: acquisitionType === "swap" ? swapOfferBrand : null,
      swapOfferType: acquisitionType === "swap" ? swapOfferType : null,
      swapOfferYear: acquisitionType === "swap" && swapOfferYear ? parseInt(swapOfferYear, 10) : null,
      swapOfferSpec: acquisitionType === "swap" ? swapOfferSpec : null,
      swapOfferWeight: acquisitionType === "swap" && swapOfferWeight ? parseInt(swapOfferWeight, 10) : null,
      swapOfferDesc: acquisitionType === "swap" ? swapOfferDesc : null,
      offerPrice: acquisitionType === "purchase" && offerPrice ? parseFloat(offerPrice) : null,
      images,
      description: description || null,
    };

    try {
      const url = isEdit ? `/api/tea-wish/${initial?.id}` : "/api/tea-wish";
      const method = isEdit ? "PUT" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "保存失败");
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="p-5">
          <h2 className="text-lg font-bold text-stone-800 mb-4">
            {isEdit ? "编辑心愿" : "添加心愿"}
          </h2>

          <form onSubmit={handleSubmit} className="space-y-3">
            {/* Want: basic attrs */}
            <p className="text-xs font-medium text-stone-500">想获取的茶品</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-stone-500 mb-1">品牌</label>
                <input value={brand} onChange={(e) => setBrand(e.target.value)} className="w-full border border-stone-300 rounded px-2.5 py-1.5 text-sm" placeholder="可选" />
              </div>
              <div>
                <label className="block text-xs text-stone-500 mb-1">年份</label>
                <input type="number" value={year} onChange={(e) => setYear(e.target.value)} min="1950" max="2030" className="w-full border border-stone-300 rounded px-2.5 py-1.5 text-sm" placeholder="可选" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-stone-500 mb-1">类型</label>
                <select value={type} onChange={(e) => setType(e.target.value)} className="w-full border border-stone-300 rounded px-2.5 py-1.5 text-sm">
                  <option value="">不限</option>
                  {TEA_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-stone-500 mb-1">规格</label>
                <select value={spec} onChange={(e) => setSpec(e.target.value)} className="w-full border border-stone-300 rounded px-2.5 py-1.5 text-sm">
                  <option value="">不限</option>
                  {WEIGHT_SPECS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>

            {/* Acquisition type */}
            <div className="pt-2 border-t border-stone-100">
              <p className="text-xs font-medium text-stone-500 mb-2">获取方式</p>
              <div className="flex gap-3">
                {ACQUISITION_TYPES.map((a) => (
                  <label key={a.value} className="flex items-center gap-1.5 text-sm">
                    <input type="radio" name="acquisitionType" value={a.value} checked={acquisitionType === a.value} onChange={() => setAcquisitionType(a.value)} />
                    {a.label}
                  </label>
                ))}
              </div>
            </div>

            {/* Conditional: swap offer */}
            {acquisitionType === "swap" && (
              <div className="space-y-2 bg-blue-50/50 rounded p-3">
                <p className="text-xs font-medium text-blue-700">我提供的茶品</p>
                <div className="grid grid-cols-2 gap-2">
                  <input value={swapOfferBrand} onChange={(e) => setSwapOfferBrand(e.target.value)} className="border border-stone-300 rounded px-2 py-1.5 text-sm" placeholder="品牌" />
                  <select value={swapOfferType} onChange={(e) => setSwapOfferType(e.target.value)} className="border border-stone-300 rounded px-2 py-1.5 text-sm">
                    {TEA_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                  <input type="number" value={swapOfferYear} onChange={(e) => setSwapOfferYear(e.target.value)} className="border border-stone-300 rounded px-2 py-1.5 text-sm" placeholder="年份" />
                  <select value={swapOfferSpec} onChange={(e) => setSwapOfferSpec(e.target.value)} className="border border-stone-300 rounded px-2 py-1.5 text-sm">
                    {WEIGHT_SPECS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
                <input type="number" value={swapOfferWeight} onChange={(e) => setSwapOfferWeight(e.target.value)} className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm" placeholder="剩余克数" />
                <textarea value={swapOfferDesc} onChange={(e) => setSwapOfferDesc(e.target.value)} rows={2} className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm resize-none" placeholder="补充描述..." />
              </div>
            )}

            {/* Conditional: purchase price */}
            {acquisitionType === "purchase" && (
              <div className="bg-amber-50/50 rounded p-3">
                <p className="text-xs font-medium text-amber-700 mb-2">意向价格</p>
                <input type="number" step="0.01" value={offerPrice} onChange={(e) => setOfferPrice(e.target.value)} className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm" placeholder="¥ 输入价格" />
              </div>
            )}

            {/* Images */}
            <div>
              <label className="block text-xs text-stone-500 mb-1">图片</label>
              <div className="flex flex-wrap gap-2 mb-2">
                {images.map((url, i) => (
                  <div key={i} className="relative w-16 h-16">
                    <img src={url} alt="" className="w-full h-full object-cover rounded" />
                    <button type="button" onClick={() => removeImage(i)} className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-[10px] rounded-full flex items-center justify-center">&times;</button>
                  </div>
                ))}
                <label className="w-16 h-16 border-2 border-dashed border-stone-300 rounded flex items-center justify-center text-stone-400 hover:border-amber-400 hover:text-amber-500 transition cursor-pointer">
                  <span className="text-xl leading-none">+</span>
                  <input type="file" accept="image/*" multiple onChange={handleImageUpload} disabled={uploading} className="hidden" />
                </label>
              </div>
              {uploading && <p className="text-xs text-amber-600 mb-1">{uploadProgress}</p>}
            </div>

            <div>
              <label className="block text-xs text-stone-500 mb-1">补充说明</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="w-full border border-stone-300 rounded px-2.5 py-1.5 text-sm resize-none" />
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            <div className="flex gap-2 pt-2">
              <button type="button" onClick={onClose} className="flex-1 border border-stone-300 text-stone-600 py-2 rounded text-sm hover:bg-stone-50 transition">取消</button>
              <button type="submit" disabled={saving || uploading} className="flex-1 bg-amber-600 text-white py-2 rounded text-sm hover:bg-amber-700 transition disabled:opacity-50">
                {saving ? "保存中..." : "保存"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
