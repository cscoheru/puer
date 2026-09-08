"use client";

import { useState, useRef } from "react";
import { uploadWithRetry } from "@/lib/upload-client";
import {
  TEA_TYPES, WEIGHT_SPECS, STORAGE_TYPES, SOURCE_TYPES,
} from "./constants";

interface Props {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initial?: any;
  onClose: () => void;
  onSaved: () => void;
}

export default function TeaInventoryForm({ initial, onClose, onSaved }: Props) {
  const isEdit = !!initial;
  const [brand, setBrand] = useState((initial?.brand as string) || "");
  const [name, setName] = useState((initial?.name as string) || "");
  const [type, setType] = useState((initial?.type as string) || "raw");
  const [year, setYear] = useState(String(initial?.year ?? new Date().getFullYear()));
  const [spec, setSpec] = useState((initial?.spec as string) || "357g");
  const [customSpec, setCustomSpec] = useState(
    initial?.spec && !["200g","250g","357g","400g","500g"].includes(initial?.spec as string)
      ? (initial?.spec as string) : ""
  );
  const [remainingWeight, setRemainingWeight] = useState(String(initial?.remainingWeight ?? ""));
  const [storage, setStorage] = useState((initial?.storage as string) || "dry_normal");

  // Duration since purchase/open (X年Y月 ago)
  function dateToDuration(d: string | undefined | null) {
    if (!d) return { y: "", m: "" };
    const dt = new Date(d);
    const now = new Date();
    let years = now.getFullYear() - dt.getFullYear();
    let months = now.getMonth() - dt.getMonth();
    if (months < 0) { years--; months += 12; }
    if (years < 0) return { y: "", m: "" };
    if (years >= 20) return { y: "20+", m: "0" };
    return { y: String(years), m: String(months) };
  }
  const [purchaseYears, setPurchaseYears] = useState(dateToDuration(initial?.purchaseTime as string | undefined).y);
  const [purchaseMonths, setPurchaseMonths] = useState(dateToDuration(initial?.purchaseTime as string | undefined).m);
  const [openYears, setOpenYears] = useState(dateToDuration(initial?.openTime as string | undefined).y);
  const [openMonths, setOpenMonths] = useState(dateToDuration(initial?.openTime as string | undefined).m);
  const [source, setSource] = useState((initial?.source as string) || "");
  const [description, setDescription] = useState((initial?.description as string) || "");
  const [estimatedValue, setEstimatedValue] = useState(
    initial?.estimatedValue ? String(initial.estimatedValue) : ""
  );
  const [images, setImages] = useState<string[]>((initial?.images as string[]) || []);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [error, setError] = useState("");
  const [validityDays, setValidityDays] = useState(String(initial?.validityDays ?? ""));

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

  // Drag-to-reorder
  const dragIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  function handleDragStart(idx: number) {
    dragIdx.current = idx;
  }

  function handleDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault();
    setDragOverIdx(idx);
  }

  function handleDrop(targetIdx: number) {
    const from = dragIdx.current;
    if (from === null || from === targetIdx) {
      dragIdx.current = null;
      setDragOverIdx(null);
      return;
    }
    setImages((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(targetIdx, 0, moved);
      return next;
    });
    dragIdx.current = null;
    setDragOverIdx(null);
  }

  function handleDragEnd() {
    dragIdx.current = null;
    setDragOverIdx(null);
  }

  // Touch reorder
  const touchIdx = useRef<number | null>(null);
  const touchClone = useRef<HTMLDivElement | null>(null);

  function handleTouchStart(e: React.TouchEvent, idx: number) {
    touchIdx.current = idx;
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const clone = el.cloneNode(true) as HTMLDivElement;
    clone.style.position = "fixed";
    clone.style.left = `${rect.left}px`;
    clone.style.top = `${rect.top}px`;
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.opacity = "0.7";
    clone.style.zIndex = "9999";
    clone.style.pointerEvents = "none";
    document.body.appendChild(clone);
    touchClone.current = clone;
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (touchIdx.current === null) return;
    e.preventDefault();
    const touch = e.touches[0];
    if (touchClone.current) {
      touchClone.current.style.left = `${touch.clientX - 32}px`;
      touchClone.current.style.top = `${touch.clientY - 32}px`;
    }
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    const thumb = el?.closest("[data-img-idx]");
    if (thumb) {
      setDragOverIdx(parseInt(thumb.getAttribute("data-img-idx")!, 10));
    }
  }

  function handleTouchEnd() {
    if (touchIdx.current !== null && dragOverIdx !== null && touchIdx.current !== dragOverIdx) {
      const from = touchIdx.current;
      const target = dragOverIdx;
      setImages((prev) => {
        const next = [...prev];
        const [moved] = next.splice(from, 1);
        next.splice(target, 0, moved);
        return next;
      });
    }
    if (touchClone.current) {
      document.body.removeChild(touchClone.current);
      touchClone.current = null;
    }
    touchIdx.current = null;
    setDragOverIdx(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);

    const effectiveSpec = spec === "other" && customSpec.trim() ? customSpec.trim() : spec;

    function durationToDate(y: string, m: string): string | null {
      if (!y) return null;
      const years = y === "20+" ? 20 : parseInt(y);
      const months = parseInt(m || "0");
      const d = new Date();
      d.setFullYear(d.getFullYear() - years);
      d.setMonth(d.getMonth() - months);
      return d.toISOString();
    }
    const purchaseTime = durationToDate(purchaseYears, purchaseMonths);
    const openTime = durationToDate(openYears, openMonths);
    const body = { brand, name: name || null, type, year, spec: effectiveSpec, remainingWeight, storage, purchaseTime, source: source || null, openTime, description: description || null, estimatedValue: estimatedValue || null, images, validityDays: validityDays ? parseInt(validityDays, 10) : null };

    try {
      const url = isEdit ? `/api/tea-inventory/${initial?.id}` : "/api/tea-inventory";
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
            {isEdit ? "编辑茶版" : "添加茶版"}
          </h2>

          <form onSubmit={handleSubmit} className="space-y-3">
            {/* Brand + Type */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-stone-500 mb-1">品牌 *</label>
                <input value={brand} onChange={(e) => setBrand(e.target.value)} required className="w-full border border-stone-300 rounded px-2.5 py-1.5 text-sm" placeholder="如：大益" />
              </div>
              <div>
                <label className="block text-xs text-stone-500 mb-1">品名</label>
                <input value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-stone-300 rounded px-2.5 py-1.5 text-sm" placeholder="如：7542、8582" />
              </div>
            </div>

            {/* Type + Year */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-stone-500 mb-1">类型 *</label>
                <div className="flex gap-2 mt-1">
                  {TEA_TYPES.map((t) => (
                    <label key={t.value} className="flex items-center gap-1 text-sm">
                      <input type="radio" name="type" value={t.value} checked={type === t.value} onChange={() => setType(t.value)} />
                      {t.label}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs text-stone-500 mb-1">年份 *</label>
                <input type="number" value={year} onChange={(e) => setYear(e.target.value)} required min="1950" max="2030" className="w-full border border-stone-300 rounded px-2.5 py-1.5 text-sm" />
              </div>
            </div>

            {/* Spec */}
            <div>
              <label className="block text-xs text-stone-500 mb-1">规格 *</label>
              {spec === "other" ? (
                <div className="flex gap-2">
                  <select value={spec} onChange={(e) => setSpec(e.target.value)} className="w-28 border border-stone-300 rounded px-2.5 py-1.5 text-sm">
                    {WEIGHT_SPECS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                  <input value={customSpec} onChange={(e) => setCustomSpec(e.target.value)} className="flex-1 border border-stone-300 rounded px-2.5 py-1.5 text-sm" placeholder="输入规格，如：1000g" required />
                </div>
              ) : (
                <select value={spec} onChange={(e) => setSpec(e.target.value)} className="w-full border border-stone-300 rounded px-2.5 py-1.5 text-sm">
                  {WEIGHT_SPECS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              )}
            </div>

            {/* Weight + Storage */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-stone-500 mb-1">剩余克数（含棉纸）*</label>
                <input type="number" value={remainingWeight} onChange={(e) => setRemainingWeight(e.target.value)} required min="1" className="w-full border border-stone-300 rounded px-2.5 py-1.5 text-sm" placeholder="克" />
              </div>
              <div>
                <label className="block text-xs text-stone-500 mb-1">仓储 *</label>
                <select value={storage} onChange={(e) => setStorage(e.target.value)} className="w-full border border-stone-300 rounded px-2.5 py-1.5 text-sm">
                  {STORAGE_TYPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>

            {/* Purchase time (X年Y月 ago) + Source */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-stone-500 mb-1">购买时间</label>
                <div className="flex gap-1">
                  <select value={purchaseYears} onChange={(e) => {
                    setPurchaseYears(e.target.value);
                    // Default open time to same as purchase
                    if (!openYears) { setOpenYears(e.target.value); setOpenMonths("0"); }
                  }} className="flex-1 border border-stone-300 rounded px-2 py-1.5 text-sm">
                    <option value="">请选择</option>
                    {Array.from({ length: 20 }, (_, i) => i + 1).map((y) => (
                      <option key={y} value={y}>{y}年前</option>
                    ))}
                    <option value="20+">20年以上</option>
                  </select>
                  <select value={purchaseMonths} onChange={(e) => setPurchaseMonths(e.target.value)} className="w-20 border border-stone-300 rounded px-2 py-1.5 text-sm">
                    {Array.from({ length: 12 }, (_, i) => i).map((m) => (
                      <option key={m} value={m}>{m}个月</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs text-stone-500 mb-1">货源</label>
                <select value={source} onChange={(e) => setSource(e.target.value)} className="w-full border border-stone-300 rounded px-2.5 py-1.5 text-sm">
                  <option value="">请选择</option>
                  {SOURCE_TYPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>

            {/* Open time (X年Y月 ago) */}
            <div>
              <label className="block text-xs text-stone-500 mb-1">开版时间</label>
              <div className="flex gap-1">
                <select value={openYears} onChange={(e) => setOpenYears(e.target.value)} className="flex-1 border border-stone-300 rounded px-2 py-1.5 text-sm">
                  <option value="">请选择</option>
                  {Array.from({ length: 20 }, (_, i) => i + 1).map((y) => {
                    const disabled = !!(purchaseYears && purchaseYears !== "20+" && y > parseInt(purchaseYears));
                    const isExact = purchaseYears && purchaseYears !== "20+" && y === parseInt(purchaseYears);
                    return (
                      <option key={y} value={y} disabled={disabled}>
                        {y}年前{isExact ? "（同购买）" : ""}
                      </option>
                    );
                  })}
                  <option value="20+" disabled={purchaseYears !== "20+"}>20年以上</option>
                </select>
                <select value={openMonths} onChange={(e) => setOpenMonths(e.target.value)} className="w-20 border border-stone-300 rounded px-2 py-1.5 text-sm">
                  {Array.from({ length: 12 }, (_, i) => i).map((m) => {
                    const disabled = purchaseYears !== "" && openYears === purchaseYears && purchaseMonths !== "" && m > parseInt(purchaseMonths);
                    return (
                      <option key={m} value={m} disabled={disabled}>{m}个月</option>
                    );
                  })}
                </select>
              </div>
              {purchaseYears && !openYears && (
                <p className="text-[10px] text-stone-400 mt-0.5">开版时间默认同购买时间</p>
              )}
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs text-stone-500 mb-1">描述</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="w-full border border-stone-300 rounded px-2.5 py-1.5 text-sm resize-none" placeholder="补充说明..." />
            </div>

            {/* Estimated value */}
            <div>
              <label className="block text-xs text-stone-500 mb-1">茶版估价（元）</label>
              <div className="flex items-center gap-1">
                <input type="number" value={estimatedValue} onChange={(e) => setEstimatedValue(e.target.value)} min="0" step="0.01" className="w-40 border border-stone-300 rounded px-2.5 py-1.5 text-sm" placeholder="估价金额" />
                <span className="text-sm text-stone-400">元</span>
              </div>
            </div>

            {/* Validity period */}
            <div>
              <label className="block text-xs text-stone-500 mb-1">有效期（天）</label>
              <input type="number" value={validityDays} onChange={(e) => setValidityDays(e.target.value)} min="1" max="365" className="w-full border border-stone-300 rounded px-2.5 py-1.5 text-sm" placeholder="留空表示永久有效" />
              <p className="text-[10px] text-stone-400 mt-0.5">到期后茶版将自动失效变灰，可随时续期</p>
            </div>

            {/* Images — multi-select with drag-to-reorder */}
            <div>
              <label className="block text-xs text-stone-500 mb-1">图片 <span className="text-stone-300">（拖动排序，第一张为封面）</span></label>
              <div className="flex flex-wrap gap-2 mb-2">
                {images.map((url, i) => (
                  <div
                    key={i}
                    data-img-idx={i}
                    draggable
                    onDragStart={() => handleDragStart(i)}
                    onDragOver={(e) => handleDragOver(e, i)}
                    onDrop={() => handleDrop(i)}
                    onDragEnd={handleDragEnd}
                    onTouchStart={(e) => handleTouchStart(e, i)}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={handleTouchEnd}
                    className={`relative w-16 h-16 cursor-grab active:cursor-grabbing ${
                      dragOverIdx === i ? "ring-2 ring-amber-500 rounded" : ""
                    } ${i === 0 ? "ring-2 ring-green-400 rounded" : ""}`}
                  >
                    {i === 0 && <span className="absolute top-0.5 left-0.5 text-[8px] bg-green-500 text-white px-1 rounded-sm leading-tight z-10">封面</span>}
                    <img src={url} alt="" className="w-full h-full object-cover rounded"
                          onError={(e) => { (e.target as HTMLImageElement).src = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect fill="%23f5f5f4" width="64" height="64"/><text x="32" y="36" text-anchor="middle" fill="%23a8a29e" font-size="10">加载失败</text></svg>'); }}
                        />
                    <button type="button" onClick={() => removeImage(i)} className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-[10px] rounded-full flex items-center justify-center z-10">&times;</button>
                  </div>
                ))}
                <label className="w-16 h-16 border-2 border-dashed border-stone-300 rounded flex items-center justify-center text-stone-400 hover:border-amber-400 hover:text-amber-500 transition cursor-pointer">
                  <span className="text-xl leading-none">+</span>
                  <input type="file" accept="image/*" multiple onChange={handleImageUpload} disabled={uploading} className="hidden" />
                </label>
              </div>
              {uploading && <p className="text-xs text-amber-600 mb-1">{uploadProgress}</p>}
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            {/* Buttons */}
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={onClose} className="flex-1 border border-stone-300 text-stone-600 py-2 rounded text-sm hover:bg-stone-50 transition">
                取消
              </button>
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
