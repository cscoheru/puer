"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import RichEditor from "@/components/rich-editor";
import { uploadWithRetry } from "@/lib/upload-client";

interface MediaItem {
  id: string;
  file?: File;
  preview: string;
  type: "image" | "video";
  uploaded: boolean;
  url?: string;
  uploadProgress: number;
  uploadError?: string;
}

export default function EditThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [id, setId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [boardSlug, setBoardSlug] = useState("");
  const [authorId, setAuthorId] = useState("");
  const [images, setImages] = useState<MediaItem[]>([]);
  const [existingImages, setExistingImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [visibility, setVisibility] = useState<"public" | "private">("public");

  useEffect(() => {
    params.then(({ id }) => setId(id));
  }, [params]);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/articles/${id}`)
      .then((r) => r.json())
      .then((article) => {
        if (article.error) {
          setError(article.error);
          setLoading(false);
          return;
        }
        setTitle(article.title);
        setBoardSlug(article.board?.slug || "");
        setAuthorId(article.authorId);
        setVideoUrl(article.videoUrl || null);
        setVisibility(article.visibility === "private" ? "private" : "public");
        setLoading(false);

        // Extract images from article.images or parse from content
        const contentHtml = article.content || "";
        let imageUrls: string[] = [];

        if (article.images && Array.isArray(article.images) && article.images.length > 0) {
          imageUrls = article.images;
          // Strip <img> tags from content so RichEditor shows only text HTML
          let cleaned = contentHtml.replace(/<img[^>]*>/gi, "").trim();
          // Clean up empty paragraphs
          cleaned = cleaned.replace(/<p>\s*<\/p>/gi, "").trim();
          setContent(cleaned);
        } else {
          // Legacy: parse <img> tags from content
          const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
          let match;
          while ((match = imgRegex.exec(contentHtml)) !== null) {
            imageUrls.push(match[1]);
          }
          // Strip img tags for editor
          let cleaned = contentHtml.replace(/<img[^>]*>/gi, "").trim();
          cleaned = cleaned.replace(/<p>\s*<\/p>/gi, "").trim();
          setContent(cleaned);
        }

        setExistingImages(imageUrls);
        setImages(
          imageUrls.map((url) => ({
            id: Math.random().toString(36).slice(2),
            preview: url,
            type: "image" as const,
            uploaded: true,
            url,
            uploadProgress: 100,
          }))
        );
      })
      .catch(() => {
        setError("加载失败");
        setLoading(false);
      });
  }, [id]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "video/webm", "video/quicktime"];
    const newItems: MediaItem[] = Array.from(files)
      .filter((f) => allowedTypes.includes(f.type))
      .map((f) => ({
        id: Math.random().toString(36).slice(2),
        file: f,
        preview: URL.createObjectURL(f),
        type: f.type.startsWith("video/") ? "video" as const : "image" as const,
        uploaded: false,
        uploadProgress: 0,
      }));
    setImages((prev) => [...prev, ...newItems]);

    // Start uploading each new file immediately
    for (const item of newItems) {
      uploadWithRetry(item.file!, (progress) => {
        setImages((prev) =>
          prev.map((i) => i.id === item.id ? { ...i, uploadProgress: progress } : i)
        );
      })
        .then((result) => {
          setImages((prev) =>
            prev.map((i) => i.id === item.id
              ? { ...i, uploaded: true, url: result.url, uploadProgress: 100 }
              : i)
          );
        })
        .catch((err) => {
          setImages((prev) =>
            prev.map((i) => i.id === item.id
              ? { ...i, uploadError: err instanceof Error ? err.message : "上传失败", uploadProgress: 0 }
              : i)
          );
        });
    }
  }, []);

  const retryUpload = useCallback((id: string) => {
    setImages((prev) => {
      const item = prev.find((i) => i.id === id);
      if (!item || !item.file) return prev;
      uploadWithRetry(item.file, (progress) => {
        setImages((p) =>
          p.map((i) => i.id === id ? { ...i, uploadProgress: progress, uploadError: undefined } : i)
        );
      })
        .then((result) => {
          setImages((p) =>
            p.map((i) => i.id === id
              ? { ...i, uploaded: true, url: result.url, uploadProgress: 100 }
              : i)
          );
        })
        .catch((err) => {
          setImages((p) =>
            p.map((i) => i.id === id
              ? { ...i, uploadError: err instanceof Error ? err.message : "上传失败", uploadProgress: 0 }
              : i)
          );
        });
      return prev.map((i) => i.id === id ? { ...i, uploadError: undefined, uploadProgress: 0 } : i);
    });
  }, []);

  const removeMedia = useCallback((id: string) => {
    setImages((prev) => {
      const item = prev.find((i) => i.id === id);
      if (item && item.preview.startsWith("blob:")) URL.revokeObjectURL(item.preview);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const moveMediaItem = useCallback((id: string, direction: -1 | 1) => {
    setImages((prev) => {
      const idx = prev.findIndex((i) => i.id === id);
      if (idx < 0) return prev;
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
      return next;
    });
  }, []);

  if (status === "loading" || loading) {
    return <div className="text-center py-12 text-stone-400">加载中...</div>;
  }

  if (status === "unauthenticated") {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 text-center">
        <p className="text-stone-500 mb-4">请先登录后编辑</p>
        <Link href="/login" className="inline-block bg-amber-800 text-white px-5 py-2.5 rounded-lg text-sm">去登录</Link>
      </div>
    );
  }

  if (session?.user?.id !== authorId && session?.user?.role !== "admin") {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 text-center">
        <p className="text-stone-500">你没有权限编辑此帖子</p>
        <Link href="/forum" className="inline-block text-amber-700 mt-2 text-sm">返回论坛</Link>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError("标题不能为空");
      return;
    }
    setSubmitting(true);
    setError("");

    try {
      // Check all files are uploaded
      const pending = images.filter((i) => !i.uploaded && !i.uploadError);
      if (pending.length > 0) {
        setError(`还有 ${pending.length} 个文件正在上传，请等待`);
        setSubmitting(false);
        return;
      }
      const failed = images.filter((i) => !!i.uploadError);
      if (failed.length > 0) {
        setError(`${failed.length} 个文件上传失败，请删除或重试`);
        setSubmitting(false);
        return;
      }

      const uploadedImages = images.filter((i) => i.url && i.type === "image");
      const uploadedVideos = images.filter((i) => i.url && i.type === "video");
      // Use new video if uploaded, otherwise keep existing
      const finalVideoUrl = uploadedVideos.length > 0 ? uploadedVideos[0].url : videoUrl;

      // Build content = editor text + <img> tags preserving order
      const imageHtml = uploadedImages.map((i) => `<img src="${i.url}" alt="">`).join("");
      const finalContent = content.trim()
        ? `${content}\n${imageHtml}`
        : imageHtml || "";

      const res = await fetch(`/api/articles/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          content: finalContent,
          images: uploadedImages.map((i) => i.url),
          videoUrl: finalVideoUrl,
          visibility,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "编辑失败");
      }
      router.push(`/forum/thread/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "编辑失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-10">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">品茶论坛</Link>
        {boardSlug && (
          <>
            <span className="mx-2">/</span>
            <Link href={`/forum/${boardSlug}`} className="hover:text-amber-700 transition">版块</Link>
          </>
        )}
        <span className="mx-2">/</span>
        <span className="text-stone-600">编辑帖子</span>
      </nav>

      <h1 className="text-2xl md:text-3xl font-serif font-bold text-stone-800 mb-6">编辑帖子</h1>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">标题 *</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
            className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">文字内容</label>
          <RichEditor value={content} onChange={setContent} placeholder="编辑文字内容..." />
          <p className="text-xs text-stone-400 mt-1">图片在下方管理，不需要在文字中插入</p>
        </div>

        {/* Image gallery */}
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">图片</label>

          {/* Drop zone */}
          <div
            className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition ${
              dragOver ? "border-amber-500 bg-amber-50" : "border-stone-300 hover:border-stone-400"
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
            onClick={() => fileInputRef.current?.click()}
          >
            <svg className="mx-auto w-8 h-8 text-stone-300 mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <p className="text-sm text-stone-600">点击或拖拽添加图片</p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime"
            className="hidden"
            onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); }}
          />

          {/* Preview grid */}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {images.map((item, idx) => (
                <div key={item.id} className="relative group w-[calc(33.333%-6px)] md:w-[calc(25%-8px)] aspect-square bg-stone-100 rounded-lg overflow-hidden border border-stone-200">
                  {item.type === "image" ? (
                    <img src={item.preview} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <video src={item.preview} className="w-full h-full object-cover" />
                  )}

                  {/* Order badge */}
                  <div className="absolute top-1 left-1 bg-black/60 text-white text-[0.625rem] px-1.5 py-0.5 rounded font-mono min-w-[20px] text-center">
                    {idx + 1}
                  </div>

                  {/* PC hover reorder buttons */}
                  <div className="absolute inset-x-0 bottom-0 flex justify-center gap-0 bg-gradient-to-t from-black/50 to-transparent pt-5 pb-1 opacity-0 group-hover:opacity-100 transition">
                    {idx > 0 && (
                      <button
                        type="button"
                        onClick={() => moveMediaItem(item.id, -1)}
                        className="w-7 h-7 bg-white/90 text-stone-700 rounded-full text-xs hover:bg-white hover:text-amber-700 transition shadow-sm touch-manipulation"
                        aria-label="左移"
                      >◀</button>
                    )}
                    {idx < images.length - 1 && (
                      <button
                        type="button"
                        onClick={() => moveMediaItem(item.id, 1)}
                        className="w-7 h-7 bg-white/90 text-stone-700 rounded-full text-xs hover:bg-white hover:text-amber-700 transition shadow-sm touch-manipulation"
                        aria-label="右移"
                      >▶</button>
                    )}
                  </div>

                  {/* Mobile touch reorder buttons */}
                  <div className="absolute bottom-1 left-1 right-1 flex justify-between opacity-70 md:hidden">
                    {idx > 0 ? (
                      <button
                        type="button"
                        onClick={() => moveMediaItem(item.id, -1)}
                        className="w-8 h-8 bg-black/50 text-white rounded-lg text-sm flex items-center justify-center active:bg-black/70"
                        aria-label="左移"
                      >←</button>
                    ) : <div />}
                    {idx < images.length - 1 ? (
                      <button
                        type="button"
                        onClick={() => moveMediaItem(item.id, 1)}
                        className="w-8 h-8 bg-black/50 text-white rounded-lg text-sm flex items-center justify-center active:bg-black/70"
                        aria-label="右移"
                      >→</button>
                    ) : <div />}
                  </div>

                  {item.type === "video" && (
                    <span className="absolute bottom-7 left-1 text-[0.625rem] bg-black/60 text-white px-1 py-0.5 rounded pointer-events-none">
                      视频
                    </span>
                  )}

                  {/* Delete */}
                  <button
                    type="button"
                    onClick={() => removeMedia(item.id)}
                    className="absolute top-1 right-1 w-6 h-6 bg-black/50 text-white rounded-full text-xs hover:bg-red-500 transition shadow-sm"
                  >✕</button>

                  {!item.uploaded && (
                    <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center gap-1.5">
                      {item.uploadError ? (
                        <>
                          <span className="text-red-300 text-[0.625rem] text-center px-1 leading-tight">{item.uploadError}</span>
                          {item.uploadError === "上传已取消" ? (
                            <button
                              type="button"
                              onClick={() => retryUpload(item.id)}
                              className="text-[0.625rem] text-white underline"
                            >
                              重试
                            </button>
                          ) : (
                            <span className="text-amber-300 text-[0.625rem]">正在自动重试...</span>
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
                          <span className="text-white text-[0.625rem]">
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
            <p className="text-xs text-stone-400 mt-1">仅你自己可见</p>
          )}
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
          <Link href={`/forum/thread/${id}`} className="text-sm text-stone-500 hover:text-stone-700 transition">
            取消
          </Link>
        </div>
      </form>
    </div>
  );
}
