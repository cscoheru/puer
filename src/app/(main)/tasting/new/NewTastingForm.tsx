"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { uploadWithRetry } from "@/lib/upload-client";

interface Tea {
  id: string;
  name: string;
  brand: string;
  year: number;
}

interface MediaItem {
  id: string;
  file: File;
  preview: string;
  uploaded: boolean;
  url?: string;
  uploadProgress: number;
  uploadError?: string;
}

const SCORE_FIELDS: { key: "appearance" | "color" | "aroma" | "taste" | "aftertaste"; label: string }[] = [
  { key: "appearance", label: "外观" },
  { key: "color", label: "汤色" },
  { key: "aroma", label: "香气" },
  { key: "taste", label: "滋味" },
  { key: "aftertaste", label: "回甘" },
];

export default function NewTastingForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [content, setContent] = useState("");
  const [scores, setScores] = useState<Record<string, string>>({
    appearance: "", color: "", aroma: "", taste: "", aftertaste: "",
  });
  const [brewMethod, setBrewMethod] = useState("");
  const [waterTemp, setWaterTemp] = useState("");
  const [teaWeight, setTeaWeight] = useState("");
  const [steepCount, setSteepCount] = useState("");
  const [teaSearch, setTeaSearch] = useState("");
  const [teaResults, setTeaResults] = useState<Tea[]>([]);
  const [selectedTea, setSelectedTea] = useState<Tea | null>(null);
  const [teaSearchOpen, setTeaSearchOpen] = useState(false);
  const teaRef = useRef<HTMLDivElement>(null);
  // Multi-image upload (replicated from forum/new, images-only)
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!teaSearch.trim()) { setTeaResults([]); return; }
    const t = setTimeout(() => {
      fetch(`/api/teas?q=${encodeURIComponent(teaSearch)}&limit=10`)
        .then((r) => r.json())
        .then((d) => setTeaResults(d.teas || []))
        .catch(() => setTeaResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [teaSearch]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (teaRef.current && !teaRef.current.contains(e.target as Node)) setTeaSearchOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Revoke object URLs on unmount / change
  useEffect(() => {
    return () => { mediaItems.forEach((item) => URL.revokeObjectURL(item.preview)); };
  }, [mediaItems]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    const newItems: MediaItem[] = Array.from(files)
      .filter((f) => allowedTypes.includes(f.type))
      .map((f) => ({
        id: Math.random().toString(36).slice(2),
        file: f,
        preview: URL.createObjectURL(f),
        uploaded: false,
        uploadProgress: 0,
      }));
    setMediaItems((prev) => [...prev, ...newItems]);
    for (const item of newItems) {
      uploadWithRetry(item.file, (progress) => {
        setMediaItems((prev) => prev.map((i) => i.id === item.id ? { ...i, uploadProgress: progress } : i));
      })
        .then((result) => {
          setMediaItems((prev) => prev.map((i) => i.id === item.id ? { ...i, uploaded: true, url: result.url, uploadProgress: 100 } : i));
        })
        .catch((err) => {
          setMediaItems((prev) => prev.map((i) => i.id === item.id ? { ...i, uploadError: err instanceof Error ? err.message : "上传失败", uploadProgress: 0 } : i));
        });
    }
  }, []);

  const retryUpload = useCallback((id: string) => {
    setMediaItems((prev) => {
      const item = prev.find((i) => i.id === id);
      if (!item) return prev;
      uploadWithRetry(item.file, (progress) => {
        setMediaItems((p) => p.map((i) => i.id === id ? { ...i, uploadProgress: progress, uploadError: undefined } : i));
      })
        .then((result) => {
          setMediaItems((p) => p.map((i) => i.id === id ? { ...i, uploaded: true, url: result.url, uploadProgress: 100 } : i));
        })
        .catch((err) => {
          setMediaItems((p) => p.map((i) => i.id === id ? { ...i, uploadError: err instanceof Error ? err.message : "上传失败", uploadProgress: 0 } : i));
        });
      return prev.map((i) => i.id === id ? { ...i, uploadError: undefined, uploadProgress: 0 } : i);
    });
  }, []);

  const removeMedia = useCallback((id: string) => {
    setMediaItems((prev) => {
      const item = prev.find((i) => i.id === id);
      if (item) URL.revokeObjectURL(item.preview);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const moveMediaItem = useCallback((id: string, direction: -1 | 1) => {
    setMediaItems((prev) => {
      const idx = prev.findIndex((i) => i.id === id);
      if (idx < 0) return prev;
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
      return next;
    });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTea) { setError("请选择关联茶品"); return; }
    if (!title.trim() || !content.trim()) { setError("请填写标题和内容"); return; }
    const pending = mediaItems.filter((i) => !i.uploaded && !i.uploadError);
    if (pending.length > 0) { setError(`还有 ${pending.length} 张图片正在上传，请等待`); return; }
    const failedImgs = mediaItems.filter((i) => !!i.uploadError);
    if (failedImgs.length > 0) { setError(`${failedImgs.length} 张图片上传失败，请删除或重试`); return; }
    const imageUrls = mediaItems.filter((i) => i.uploaded && i.url).map((i) => i.url!);
    setSubmitting(true);
    setError("");
    try {
      const num = (v: string) => (v === "" ? undefined : Number(v));
      const res = await fetch("/api/tasting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          content: content.trim(),
          summary: summary.trim() || undefined,
          teaId: selectedTea.id,
          appearance: num(scores.appearance),
          color: num(scores.color),
          aroma: num(scores.aroma),
          taste: num(scores.taste),
          aftertaste: num(scores.aftertaste),
          brewMethod: brewMethod || undefined,
          waterTemp: num(waterTemp),
          teaWeight: teaWeight || undefined,
          steepCount: num(steepCount),
          images: imageUrls,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "发布失败");
      }
      const note = await res.json();
      router.push(`/tasting/${note.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "发布失败");
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls = "w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500";

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-10">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/tasting" className="hover:text-amber-700 transition">茶记</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">发布新茶记</span>
      </nav>

      <h1 className="text-2xl md:text-3xl font-serif font-bold text-stone-800 mb-6">发布新茶记</h1>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Tea association (required) */}
        <div ref={teaRef}>
          <label className="block text-sm font-medium text-stone-700 mb-1">关联茶品 *</label>
          {selectedTea ? (
            <div className="flex items-center gap-2 p-2.5 bg-amber-50 border border-amber-200 rounded-lg">
              <span className="text-sm text-amber-900">{selectedTea.brand} {selectedTea.name} ({selectedTea.year})</span>
              <button type="button" onClick={() => { setSelectedTea(null); setTeaSearch(""); }}
                className="ml-auto text-xs text-stone-400 hover:text-red-500 transition">清除</button>
            </div>
          ) : (
            <div className="relative">
              <input type="text" value={teaSearch}
                onChange={(e) => { setTeaSearch(e.target.value); setTeaSearchOpen(true); }}
                onFocus={() => setTeaSearchOpen(true)} placeholder="搜索茶品..."
                className={inputCls} />
              {teaSearchOpen && teaResults.length > 0 && (
                <div className="absolute z-10 mt-1 w-full bg-white border border-stone-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {teaResults.map((t) => (
                    <button key={t.id} type="button"
                      onClick={() => { setSelectedTea(t); setTeaSearch(""); setTeaSearchOpen(false); }}
                      className="w-full text-left px-3 py-2 text-sm text-stone-700 hover:bg-amber-50 transition">
                      {t.brand} {t.name} ({t.year})
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">标题 *</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200}
            className={inputCls} placeholder="如：2023年大益7572品鉴" />
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">摘要（可选）</label>
          <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={500}
            className={inputCls} placeholder="一句话总结" />
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">品鉴内容 *</label>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} required rows={8}
            className={`${inputCls} resize-y`} placeholder="详细记录干茶、汤色、香气、滋味、叶底..." />
        </div>

        {/* Image upload (≥4 → auto slideshow video) */}
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">图片（≥4 张自动生成轮播视频）</label>
          <div
            className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition ${dragOver ? "border-amber-500 bg-amber-50" : "border-stone-300 hover:border-stone-400"}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
            onClick={() => fileInputRef.current?.click()}
          >
            <p className="text-sm text-stone-600">拖拽图片到此处，或点击选择</p>
            <p className="text-xs text-stone-400 mt-1">支持 JPG/PNG/GIF/WebP，封面停在第一张</p>
          </div>
          <input ref={fileInputRef} type="file" multiple accept="image/jpeg,image/png,image/gif,image/webp"
            className="hidden"
            onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); }} />
          {mediaItems.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {mediaItems.map((item, idx) => (
                <div key={item.id} className="relative group w-[calc(33.333%-6px)] md:w-[calc(25%-8px)] aspect-square bg-stone-100 rounded-lg overflow-hidden">
                  <img src={item.preview} alt="" className="w-full h-full object-cover" />
                  <div className="absolute top-1 left-1 bg-black/60 text-white text-[0.625rem] px-1.5 py-0.5 rounded font-mono">{idx + 1}</div>
                  <div className="absolute inset-x-0 bottom-0 flex justify-center gap-0 bg-gradient-to-t from-black/50 to-transparent pt-5 pb-1 opacity-0 group-hover:opacity-100 transition">
                    {idx > 0 && <button type="button" onClick={() => moveMediaItem(item.id, -1)} className="w-7 h-7 bg-white/90 text-stone-700 rounded-full text-xs hover:bg-white hover:text-amber-700 transition shadow-sm" aria-label="左移">◀</button>}
                    {idx < mediaItems.length - 1 && <button type="button" onClick={() => moveMediaItem(item.id, 1)} className="w-7 h-7 bg-white/90 text-stone-700 rounded-full text-xs hover:bg-white hover:text-amber-700 transition shadow-sm" aria-label="右移">▶</button>}
                  </div>
                  <div className="absolute bottom-1 left-1 right-1 flex justify-between opacity-70 md:hidden">
                    {idx > 0 ? <button type="button" onClick={() => moveMediaItem(item.id, -1)} className="w-8 h-8 bg-black/50 text-white rounded-lg text-sm flex items-center justify-center active:bg-black/70" aria-label="左移">←</button> : <div />}
                    {idx < mediaItems.length - 1 ? <button type="button" onClick={() => moveMediaItem(item.id, 1)} className="w-8 h-8 bg-black/50 text-white rounded-lg text-sm flex items-center justify-center active:bg-black/70" aria-label="右移">→</button> : <div />}
                  </div>
                  <button type="button" onClick={() => removeMedia(item.id)} className="absolute top-1 right-1 w-6 h-6 bg-black/50 text-white rounded-full text-xs hover:bg-red-500 transition shadow-sm">✕</button>
                  {!item.uploaded && (
                    <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center gap-1.5">
                      {item.uploadError ? (
                        <>
                          <span className="text-red-300 text-[0.625rem] text-center px-1 leading-tight">{item.uploadError}</span>
                          <button type="button" onClick={() => retryUpload(item.id)} className="text-[0.625rem] text-white underline">重试</button>
                        </>
                      ) : (
                        <>
                          <div className="w-3/4 h-1.5 bg-black/30 rounded-full overflow-hidden">
                            <div className="h-full bg-amber-400 rounded-full transition-all duration-300" style={{ width: `${item.uploadProgress}%` }} />
                          </div>
                          <span className="text-white text-[0.625rem]">{item.uploadProgress > 0 ? `${item.uploadProgress}%` : "准备上传..."}</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Scores */}
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">评分（0-10，可选）</label>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {SCORE_FIELDS.map((f) => (
              <div key={f.key}>
                <span className="block text-xs text-stone-500 mb-1">{f.label}</span>
                <input type="number" min={0} max={10} value={scores[f.key]}
                  onChange={(e) => setScores({ ...scores, [f.key]: e.target.value })}
                  className={`${inputCls} px-2 py-2`} />
              </div>
            ))}
          </div>
        </div>

        {/* Brew params */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-stone-500 mb-1">冲泡方式</label>
            <select value={brewMethod} onChange={(e) => setBrewMethod(e.target.value)} className={inputCls}>
              <option value="">不选</option>
              <option value="盖碗">盖碗</option>
              <option value="壶泡">壶泡</option>
              <option value="煮茶">煮茶</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-stone-500 mb-1">水温 (℃)</label>
            <input type="number" min={0} max={100} value={waterTemp}
              onChange={(e) => setWaterTemp(e.target.value)} className={`${inputCls} px-2 py-2`} />
          </div>
          <div>
            <label className="block text-xs text-stone-500 mb-1">投茶量</label>
            <input value={teaWeight} onChange={(e) => setTeaWeight(e.target.value)} placeholder="如 7g"
              className={`${inputCls} px-2 py-2`} />
          </div>
          <div>
            <label className="block text-xs text-stone-500 mb-1">耐泡度</label>
            <input type="number" min={0} max={50} value={steepCount}
              onChange={(e) => setSteepCount(e.target.value)} className={`${inputCls} px-2 py-2`} />
          </div>
        </div>

        {error && <p className="text-red-600 text-sm">{error}</p>}

        <div className="flex items-center gap-3">
          <button type="submit" disabled={submitting}
            className="px-6 py-3 bg-amber-800 text-white rounded-lg text-sm font-medium hover:bg-amber-900 disabled:opacity-50 transition min-h-[44px]">
            {submitting ? "发布中（生成视频约需10-30秒）..." : "发布茶记"}
          </button>
          <Link href="/tasting" className="text-sm text-stone-500 hover:text-stone-700 transition">取消</Link>
        </div>
      </form>
    </div>
  );
}
