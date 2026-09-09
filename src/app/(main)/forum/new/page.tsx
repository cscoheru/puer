"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import RichEditor from "@/components/rich-editor";
import { FLAIRS } from "@/lib/forum-constants";
import { uploadWithRetry } from "@/lib/upload-client";

interface Board {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
}

interface MediaItem {
  id: string;
  file: File;
  preview: string;
  type: "image" | "video";
  uploaded: boolean;
  url?: string;
  uploadProgress: number;
  uploadError?: string;
}

export default function NewThreadPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [boards, setBoards] = useState<Board[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [content, setContent] = useState("");
  const [flair, setFlair] = useState("");
  const [postType, setPostType] = useState<"text" | "media">("text");
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [teaSearch, setTeaSearch] = useState("");
  const [teaResults, setTeaResults] = useState<{ id: string; name: string; brand: string; year: number }[]>([]);
  const [selectedTea, setSelectedTea] = useState<{ id: string; name: string; brand: string; year: number } | null>(null);
  const [teaSearchOpen, setTeaSearchOpen] = useState(false);
  const teaSearchRef = useRef<HTMLDivElement>(null);
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  // P2-R2 深链预填状态（/forum/new?board=...&tea=...&title=...）
  const [boardSlug, setBoardSlug] = useState("");
  const [title, setTitle] = useState("");

  useEffect(() => {
    fetch("/api/boards")
      .then((res) => res.json())
      .then(setBoards)
      .catch(() => {});
  }, []);

  // P2-R2 深链预填：从茶品档案页"发布跟进帖"进入时，自动选中版块、
  // 关联茶品并预填标题。茶品信息由跳转方通过查询参数携带，避免额外请求。
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const b = sp.get("board");
    const teaId = sp.get("tea");
    const teaName = sp.get("teaName");
    if (b) setBoardSlug(b);
    if (teaId && teaName) {
      setSelectedTea({
        id: teaId,
        name: teaName,
        brand: sp.get("teaBrand") || "",
        year: sp.get("teaYear") ? parseInt(sp.get("teaYear")!, 10) || 0 : 0,
      });
    }
    const t = sp.get("title");
    if (t) setTitle(t.slice(0, 200));
  }, []);

  // Cleanup object URLs
  useEffect(() => {
    return () => {
      mediaItems.forEach((item) => URL.revokeObjectURL(item.preview));
    };
  }, [mediaItems]);

  // Tea search
  useEffect(() => {
    if (!teaSearch.trim()) { setTeaResults([]); return; }
    const timer = setTimeout(() => {
      fetch(`/api/teas?q=${encodeURIComponent(teaSearch)}&limit=10`)
        .then((r) => r.json())
        .then((d) => setTeaResults(d.teas || []))
        .catch(() => setTeaResults([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [teaSearch]);

  // Close tea search dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (teaSearchRef.current && !teaSearchRef.current.contains(e.target as Node)) {
        setTeaSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const addFiles = useCallback((files: FileList | File[]) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "video/webm", "video/quicktime"];
    const newItems: MediaItem[] = Array.from(files)
      .filter((f) => allowedTypes.includes(f.type))
      .map((f) => ({
        id: Math.random().toString(36).slice(2),
        file: f,
        preview: URL.createObjectURL(f),
        type: f.type.startsWith("video/") ? "video" : "image",
        uploaded: false,
        uploadProgress: 0,
      }));
    setMediaItems((prev) => [...prev, ...newItems]);

    // Start uploading each new file immediately
    for (const item of newItems) {
      uploadWithRetry(item.file, (progress) => {
        setMediaItems((prev) =>
          prev.map((i) => i.id === item.id ? { ...i, uploadProgress: progress } : i)
        );
      })
        .then((result) => {
          setMediaItems((prev) =>
            prev.map((i) => i.id === item.id
              ? { ...i, uploaded: true, url: result.url, uploadProgress: 100 }
              : i)
          );
        })
        .catch((err) => {
          setMediaItems((prev) =>
            prev.map((i) => i.id === item.id
              ? { ...i, uploadError: err instanceof Error ? err.message : "上传失败", uploadProgress: 0 }
              : i)
          );
        });
    }
  }, []);

  const retryUpload = useCallback((id: string) => {
    setMediaItems((prev) => {
      const item = prev.find((i) => i.id === id);
      if (!item) return prev;
      // Clear error and retry
      uploadWithRetry(item.file, (progress) => {
        setMediaItems((p) =>
          p.map((i) => i.id === id ? { ...i, uploadProgress: progress, uploadError: undefined } : i)
        );
      })
        .then((result) => {
          setMediaItems((p) =>
            p.map((i) => i.id === id
              ? { ...i, uploaded: true, url: result.url, uploadProgress: 100 }
              : i)
          );
        })
        .catch((err) => {
          setMediaItems((p) =>
            p.map((i) => i.id === id
              ? { ...i, uploadError: err instanceof Error ? err.message : "上传失败", uploadProgress: 0 }
              : i)
          );
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

  if (status === "loading") {
    return <div className="text-center py-12 text-stone-400">加载中...</div>;
  }

  if (status === "unauthenticated") {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 text-center">
        <p className="text-stone-500 mb-4">请先登录后发帖</p>
        <Link href="/login" className="inline-block bg-amber-800 text-white px-5 py-2.5 rounded-lg text-sm hover:bg-amber-900 transition">
          去登录
        </Link>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");

    const form = e.target as HTMLFormElement;
    const slug = (form.elements.namedItem("board") as HTMLSelectElement).value;
    const title = (form.elements.namedItem("title") as HTMLInputElement).value.trim();

    if (!slug) {
      setError("请选择版块");
      setSubmitting(false);
      return;
    }

    try {
      let finalContent = content;
      let videoUrl: string | undefined;
      let imageUrls: string[] = [];

      if (postType === "media") {
        if (mediaItems.length === 0) {
          setError("请至少上传一个文件");
          setSubmitting(false);
          return;
        }
        // Check all files are uploaded
        const pending = mediaItems.filter((i) => !i.uploaded && !i.uploadError);
        if (pending.length > 0) {
          setError(`还有 ${pending.length} 个文件正在上传，请等待`);
          setSubmitting(false);
          return;
        }
        const failed = mediaItems.filter((i) => !!i.uploadError);
        if (failed.length > 0) {
          setError(`${failed.length} 个文件上传失败，请删除或重试`);
          setSubmitting(false);
          return;
        }
        // Build content from already-uploaded files
        const allVideos = mediaItems.filter((i) => i.type === "video" && i.url);
        const allImages = mediaItems.filter((i) => i.type === "image" && i.url);
        if (allVideos.length > 0) {
          videoUrl = allVideos[0].url;
        }
        imageUrls = allImages.map((i) => i.url!);
        finalContent = allImages.map((i) => `<img src="${i.url}" alt="">`).join("");
      }

      const res = await fetch(`/api/boards/${slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          content: finalContent,
          videoUrl,
          images: imageUrls,
          flair: flair || undefined,
          teaId: selectedTea?.id,
          visibility,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "发帖失败");
      }
      const article = await res.json();
      router.push(`/forum/thread/${article.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "发帖失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-10">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">品茶论坛</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">发布新帖</span>
      </nav>

      <h1 className="text-2xl md:text-3xl font-serif font-bold text-stone-800 mb-6">发布新帖</h1>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Post type tabs */}
        <div className="flex border-b border-stone-200">
          <button
            type="button"
            onClick={() => setPostType("text")}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition -mb-px ${
              postType === "text"
                ? "border-amber-700 text-amber-900"
                : "border-transparent text-stone-500 hover:text-stone-700"
            }`}
          >
            ✏️ 文字
          </button>
          <button
            type="button"
            onClick={() => setPostType("media")}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition -mb-px ${
              postType === "media"
                ? "border-amber-700 text-amber-900"
                : "border-transparent text-stone-500 hover:text-stone-700"
            }`}
          >
            🖼️ 图片/视频
          </button>
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">选择版块 *</label>
          <select
            name="board"
            required
            value={boards.some((b) => b.slug === boardSlug) ? boardSlug : ""}
            onChange={(e) => setBoardSlug(e.target.value)}
            className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
          >
            <option value="" disabled>请选择版块</option>
            {boards.map((b) => (
              <option key={b.id} value={b.slug}>
                {b.icon || ""} {b.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">标题 *</label>
          <input
            name="title"
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="一句话说清主题（品牌 · 年份 · 话题）"
            className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
          />
        </div>

        {postType === "text" ? (
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">内容 *</label>
            <RichEditor value={content} onChange={setContent} placeholder="写下你的想法..." />
          </div>
        ) : (
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">图片 / 视频</label>

            {/* Drop zone */}
            <div
              className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition ${
                dragOver ? "border-amber-500 bg-amber-50" : "border-stone-300 hover:border-stone-400"
              }`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
              onClick={() => fileInputRef.current?.click()}
            >
              <svg className="mx-auto w-10 h-10 text-stone-300 mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <p className="text-sm text-stone-600">拖拽文件到此处，或点击选择</p>
              <p className="text-xs text-stone-400 mt-1">支持 JPG/PNG/GIF/WebP 图片和 MP4/WebM 视频</p>
              <p className="text-xs text-amber-600 mt-0.5">有视频的帖子在热榜中自动获得加权</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime"
              className="hidden"
              onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); }}
            />

            {/* Preview grid with reorder */}
            {mediaItems.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {mediaItems.map((item, idx) => (
                  <div key={item.id} className="relative group w-[calc(33.333%-6px)] md:w-[calc(25%-8px)] aspect-square bg-stone-100 rounded-lg overflow-hidden">
                    {item.type === "image" ? (
                      <img src={item.preview} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <video src={item.preview} className="w-full h-full object-cover" />
                    )}

                    {/* Order badge */}
                    <div className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded font-mono min-w-[20px] text-center">
                      {idx + 1}
                    </div>

                    {/* Reorder buttons */}
                    <div className="absolute inset-x-0 bottom-0 flex justify-center gap-0 bg-gradient-to-t from-black/50 to-transparent pt-5 pb-1 opacity-0 group-hover:opacity-100 transition">
                      {idx > 0 && (
                        <button
                          type="button"
                          onClick={() => moveMediaItem(item.id, -1)}
                          className="w-7 h-7 bg-white/90 text-stone-700 rounded-full text-xs hover:bg-white hover:text-amber-700 transition shadow-sm touch-manipulation"
                          aria-label="左移"
                        >
                          ◀
                        </button>
                      )}
                      {idx < mediaItems.length - 1 && (
                        <button
                          type="button"
                          onClick={() => moveMediaItem(item.id, 1)}
                          className="w-7 h-7 bg-white/90 text-stone-700 rounded-full text-xs hover:bg-white hover:text-amber-700 transition shadow-sm touch-manipulation"
                          aria-label="右移"
                        >
                          ▶
                        </button>
                      )}
                    </div>

                    {/* Always-visible reorder buttons for mobile touch */}
                    <div className="absolute bottom-1 left-1 right-1 flex justify-between opacity-70 md:hidden">
                      {idx > 0 ? (
                        <button
                          type="button"
                          onClick={() => moveMediaItem(item.id, -1)}
                          className="w-8 h-8 bg-black/50 text-white rounded-lg text-sm flex items-center justify-center active:bg-black/70"
                          aria-label="左移"
                        >
                          ←
                        </button>
                      ) : <div />}
                      {idx < mediaItems.length - 1 ? (
                        <button
                          type="button"
                          onClick={() => moveMediaItem(item.id, 1)}
                          className="w-8 h-8 bg-black/50 text-white rounded-lg text-sm flex items-center justify-center active:bg-black/70"
                          aria-label="右移"
                        >
                          →
                        </button>
                      ) : <div />}
                    </div>

                    {/* Delete */}
                    <button
                      type="button"
                      onClick={() => removeMedia(item.id)}
                      className="absolute top-1 right-1 w-6 h-6 bg-black/50 text-white rounded-full text-xs hover:bg-red-500 transition shadow-sm"
                    >
                      ✕
                    </button>

                    {item.type === "video" && (
                      <span className="absolute bottom-7 left-1 text-[10px] bg-black/60 text-white px-1 py-0.5 rounded">
                        视频
                      </span>
                    )}

                    {/* Upload progress overlay */}
                    {!item.uploaded && (
                      <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center gap-1.5">
                        {item.uploadError ? (
                          <>
                            <span className="text-red-300 text-[10px] text-center px-1 leading-tight">{item.uploadError}</span>
                            {item.uploadError === "上传已取消" ? (
                              <button
                                type="button"
                                onClick={() => retryUpload(item.id)}
                                className="text-[10px] text-white underline"
                              >
                                重试
                              </button>
                            ) : (
                              <span className="text-amber-300 text-[10px]">正在自动重试...</span>
                            )}
                          </>
                        ) : (
                          <>
                            <div className="w-3/4 h-1.5 bg-black/30 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-amber-400 rounded-full transition-all duration-300"
                                style={{ width: `${item.uploadProgress}%` }}
                              />
                            </div>
                            <span className="text-white text-[10px]">
                              {item.uploadProgress > 0 ? `${item.uploadProgress}%` : "准备上传..."}
                            </span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tea association */}
        <div ref={teaSearchRef}>
          <label className="block text-sm font-medium text-stone-700 mb-1">关联茶品（可选）</label>
          {selectedTea ? (
            <div className="flex items-center gap-2 p-2.5 bg-amber-50 border border-amber-200 rounded-lg">
              <span className="text-sm text-amber-900">{selectedTea.brand} {selectedTea.name} ({selectedTea.year})</span>
              <button type="button" onClick={() => { setSelectedTea(null); setTeaSearch(""); }}
                className="ml-auto text-xs text-stone-400 hover:text-red-500 transition">清除</button>
            </div>
          ) : (
            <div className="relative">
              <input
                type="text"
                value={teaSearch}
                onChange={(e) => { setTeaSearch(e.target.value); setTeaSearchOpen(true); }}
                onFocus={() => setTeaSearchOpen(true)}
                placeholder="搜索茶品..."
                className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
              />
              {teaSearchOpen && teaResults.length > 0 && (
                <div className="absolute z-10 mt-1 w-full bg-white border border-stone-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {teaResults.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => { setSelectedTea(t); setTeaSearch(""); setTeaSearchOpen(false); }}
                      className="w-full text-left px-3 py-2 text-sm text-stone-700 hover:bg-amber-50 transition"
                    >
                      {t.brand} {t.name} ({t.year})
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">标签</label>
          <select
            value={flair}
            onChange={(e) => setFlair(e.target.value)}
            className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
          >
            <option value="">不选择</option>
            {FLAIRS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">可见范围</label>
          <div className="flex gap-2">
            <button type="button" onClick={() => setVisibility("public")}
              className={`flex-1 px-3 py-2.5 rounded-lg text-sm border transition ${visibility === "public" ? "border-amber-600 bg-amber-50 text-amber-900" : "border-stone-300 text-stone-600 hover:border-stone-400"}`}>
              🌐 公开
            </button>
            <button type="button" onClick={() => setVisibility("private")}
              className={`flex-1 px-3 py-2.5 rounded-lg text-sm border transition ${visibility === "private" ? "border-amber-600 bg-amber-50 text-amber-900" : "border-stone-300 text-stone-600 hover:border-stone-400"}`}>
              🔒 仅自己可见
            </button>
          </div>
          {visibility === "private" && (
            <p className="text-xs text-stone-400 mt-1">仅你自己可见，可随时在编辑页改为公开</p>
          )}
        </div>

        {error && <p className="text-red-600 text-sm">{error}</p>}

        <div className="flex items-center gap-3">
          <button type="submit" disabled={submitting} className="px-6 py-3 bg-amber-800 text-white rounded-lg text-sm font-medium hover:bg-amber-900 disabled:opacity-50 transition min-h-[44px]">
            {submitting ? "发布中..." : "发布帖子"}
          </button>
          <Link href="/forum" className="text-sm text-stone-500 hover:text-stone-700 transition">
            取消
          </Link>
        </div>
      </form>
    </div>
  );
}
