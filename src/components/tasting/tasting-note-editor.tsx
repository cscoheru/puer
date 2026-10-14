"use client";

/**
 * TastingNoteEditor — inline admin edit island for one tasting note.
 *
 * View mode reproduces the detail page's existing markup (title header card
 * with the tea link, body, slideshow video, image grid). Edit mode swaps in a
 * title input, RichEditor body, and an image manager that adds (upload),
 * deletes, and reorders (◀▶ / ← →) images. The video is never set by hand:
 * it follows the image set through the same keep/regenerate/clear policy as
 * the drafts editor (≥4 images regenerates the ffmpeg slideshow, <4 clears),
 * plus an explicit "clear video" action.
 *
 * All writes go through PATCH /api/tasting/[id]; a successful save calls
 * router.refresh() so the server component re-renders from the DB.
 */
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import RichEditor from "@/components/rich-editor";
import ForumContent from "@/components/forum-content";
import VideoPlayer from "@/components/video-player";

interface TeaRef {
  id: string;
  name: string;
  brand: string | null;
  year: number | null;
  type: string;
}

interface Props {
  note: {
    id: string;
    title: string;
    content: string;
    images: string[];
    videoUrl: string | null;
    authorName: string;
    createdAt: string;
    tea: TeaRef;
  };
}

const ACCEPTED = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;

export default function TastingNoteEditor({ note }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [images, setImages] = useState<string[]>(note.images);
  const [videoUrl, setVideoUrl] = useState<string | null>(note.videoUrl);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle(note.title);
    setContent(note.content);
    setImages(note.images);
    setVideoUrl(note.videoUrl);
    setError(null);
  };

  const imagesDirty = images.join(" ") !== note.images.join(" ");
  const videoRemoved = videoUrl === null && !!note.videoUrl;
  const videoWillClear = !videoRemoved && imagesDirty && images.length < 4 && !!videoUrl;
  const videoWillRegen = !videoRemoved && imagesDirty && images.length >= 4;

  function move(i: number, dir: -1 | 1) {
    setImages((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  function removeAt(i: number) {
    setImages((prev) => prev.filter((_, j) => j !== i));
  }

  async function uploadImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) {
      alert("只支持 JPEG、PNG、GIF、WebP 格式");
      e.target.value = "";
      return;
    }
    if (file.size > MAX_BYTES) {
      alert("图片大小不能超过 5MB");
      e.target.value = "";
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("category", "tea");
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      const { url } = await res.json();
      if (typeof url === "string" && url) setImages((prev) => [...prev, url]);
    } catch (err) {
      alert("上传失败: " + (err instanceof Error ? err.message : "未知错误"));
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function save() {
    if (!title.trim() || !content.trim()) {
      setError("请填写标题和正文");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Server gives an explicit clearVideo priority over the automatic
      // image-driven plan, so send it whenever the admin removed the current
      // video — whether or not the image set also changed. Without this,
      // "reorder + clear" with ≥4 images would silently regenerate.
      const clearVideo = videoRemoved;
      const res = await fetch(`/api/tasting/${note.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          content,
          images,
          ...(clearVideo ? { clearVideo: true } : {}),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const saved = await res.json().catch(() => null);
      if (saved?.videoRegenFailed) {
        alert("图文已保存，但轮播视频重新生成失败——保留了旧视频，可重试保存。");
      }
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError("保存失败: " + (err instanceof Error ? err.message : "未知错误"));
    } finally {
      setSaving(false);
    }
  }

  const tea = note.tea;

  // ── View mode ──────────────────────────────────────────────────────
  if (!editing) {
    return (
      <>
        <div className="bg-white rounded-xl border border-stone-200 p-5 md:p-8 mb-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-xl md:text-3xl font-serif font-bold text-stone-800">{note.title}</h1>
              <div className="flex items-center gap-3 mt-3 text-sm text-stone-500">
                <span>{note.authorName}</span>
                <span>·</span>
                <span>{new Date(note.createdAt).toLocaleDateString("zh-CN")}</span>
              </div>
            </div>
            <button
              onClick={() => {
                reset();
                setEditing(true);
              }}
              className="shrink-0 text-xs text-amber-700 hover:text-amber-900 font-medium border border-amber-200 rounded-lg px-3 py-1.5 hover:bg-amber-50"
            >
              ✏️ 编辑
            </button>
          </div>
          <Link
            href={`/tea/${tea.id}`}
            className="flex items-center gap-3 mt-4 p-3 bg-amber-50 rounded-lg border border-amber-200 hover:bg-amber-100 transition"
          >
            <span className="text-xl">🍵</span>
            <div>
              <div className="text-sm font-medium text-amber-900">{tea.name}</div>
              <div className="text-xs text-amber-700">
                {tea.brand} · {tea.year}年 · {tea.type === "raw" ? "生茶" : "熟茶"}
              </div>
            </div>
            <span className="ml-auto text-amber-600 text-xs">查看详情 →</span>
          </Link>
        </div>

        <div className="bg-white rounded-xl border border-stone-200 p-5 md:p-8 mb-6">
          <ForumContent html={note.content} />
        </div>

        {note.videoUrl && (
          <div className="bg-white rounded-xl border border-stone-200 p-5 md:p-8 mb-6">
            <VideoPlayer src={note.videoUrl} />
          </div>
        )}

        {note.images.length > 0 && (
          <div className="bg-white rounded-xl border border-stone-200 p-5 md:p-8 mb-6">
            <h2 className="text-sm font-semibold text-stone-600 mb-3">图片 ({note.images.length})</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {note.images.map((src, i) => (
                <a
                  key={`${i}-${src}`}
                  href={src}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="aspect-[4/3] rounded-lg overflow-hidden bg-stone-100"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" className="w-full h-full object-cover hover:opacity-85 transition" />
                </a>
              ))}
            </div>
          </div>
        )}
      </>
    );
  }

  // ── Edit mode ──────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      <div className="bg-white rounded-xl border border-stone-200 p-5 md:p-8">
        <label className="block">
          <span className="text-xs text-stone-500">标题</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            className="mt-1 block w-full text-sm px-3 py-2 border border-stone-300 rounded-lg focus:outline-none focus:border-amber-500"
          />
        </label>

        <div className="mt-4 text-xs text-stone-500">
          茶品:{tea.name}(茶品归属如需调整,用经典审核里的合并/独立)
        </div>
      </div>

      <div className="bg-white rounded-xl border border-stone-200 p-5 md:p-8">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-stone-700">正文</h2>
        </div>
        <RichEditor value={content} onChange={setContent} />
      </div>

      {/* Media manager */}
      <div className="bg-white rounded-xl border border-stone-200 p-5 md:p-8">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-medium text-stone-700">
            媒体({images.length} 图{videoUrl ? " · 含视频" : ""})
          </h2>
          {videoUrl && (
            <button
              type="button"
              onClick={() => setVideoUrl(null)}
              className="text-xs text-red-600 border border-red-200 rounded-lg px-2.5 py-1 hover:bg-red-50"
            >
              🗑 清除视频
            </button>
          )}
        </div>
        <p className="text-xs text-stone-400 mb-3">
          点 ✕ 删除,点 ◀ ▶ 调整顺序(第一张为封面),点 ＋ 上传新图。视频由图片自动生成。
        </p>

        <div className="flex flex-wrap gap-2">
          {images.map((src, i) => (
            <div key={`${i}-${src}`} className="relative w-20">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={`图 ${i + 1}`}
                className="w-20 h-20 object-cover rounded border border-stone-200"
              />
              <span className="absolute top-0.5 left-0.5 bg-black/60 text-white text-[0.625rem] leading-none px-1 py-0.5 rounded font-mono">
                {i + 1}
              </span>
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-600 text-white text-xs leading-none shadow hover:bg-red-700"
                aria-label={`删除图 ${i + 1}`}
              >
                ✕
              </button>
              <div className="flex justify-between mt-1">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  className="w-8 text-xs bg-stone-100 rounded text-stone-600 hover:bg-stone-200 disabled:opacity-30"
                  aria-label={`左移图 ${i + 1}`}
                >
                  ◀
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === images.length - 1}
                  className="w-8 text-xs bg-stone-100 rounded text-stone-600 hover:bg-stone-200 disabled:opacity-30"
                  aria-label={`右移图 ${i + 1}`}
                >
                  ▶
                </button>
              </div>
            </div>
          ))}
          <label className="w-20 h-20 flex items-center justify-center rounded border border-dashed border-stone-300 text-stone-400 hover:border-amber-500 hover:text-amber-600 cursor-pointer text-xl">
            {uploading ? "…" : "＋"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              className="hidden"
              onChange={uploadImage}
              disabled={uploading}
            />
          </label>
        </div>

        {videoWillClear && (
          <p className="mt-3 text-xs text-red-600">
            ⚠️ 图片少于 4 张:保存后将清除轮播视频。
          </p>
        )}
        {videoWillRegen && (
          <p className="mt-3 text-xs text-amber-700">
            图片有改动(含换序):保存时将按新顺序重新生成轮播视频(约 10–30 秒)。
          </p>
        )}
        {videoRemoved && (
          <p className="mt-3 text-xs text-red-600">
            视频将被清除{imagesDirty && images.length >= 4 ? "(已手动清除,本次不会因图片重新生成)" : "(下次图片有改动且 ≥4 张时才会重新生成)"}。
          </p>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving || uploading}
          className="text-xs bg-amber-700 text-white px-4 py-2 rounded-lg hover:bg-amber-800 disabled:opacity-50"
        >
          {saving ? "保存中（可能在生成视频）…" : "保存"}
        </button>
        <button
          onClick={() => {
            reset();
            setEditing(false);
          }}
          disabled={saving}
          className="text-xs text-stone-500 hover:text-stone-700 px-4 py-2"
        >
          取消
        </button>
      </div>
    </div>
  );
}
