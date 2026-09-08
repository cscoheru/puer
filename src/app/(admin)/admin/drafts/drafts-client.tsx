"use client";

/**
 * DraftReviewPanel — admin review surface for a single draft.
 *
 * For tasting-note drafts (deterministic id `tasting-draft_`) it also shows the
 * read-only source note so the reviewer can confirm the draft is a faithful,
 * un-rewritten projection of the author's manual note. The banner states the
 * trust contract explicitly: no AI, no semantic rewrite.
 *
 * Actions: edit (title + RichEditor body) → save; publish (draft→published via
 * the unified transaction); archive; delete. The parent owns list refresh via
 * `onChanged`; `onClose` closes the panel.
 */
import { useEffect, useState } from "react";
import RichEditor from "@/components/rich-editor";
import { isTastingDraftId } from "@/lib/tea-drafts/id";

interface TeaInfo {
  name: string;
  brand: string | null;
  year: number | null;
  type?: string | null;
}
interface AuthorInfo {
  id: string;
  username: string;
}
interface BoardInfo {
  id: string;
  name: string;
  slug: string;
}

export interface ReviewDraft {
  id: string;
  type: string;
  title: string;
  content: string;
  summary: string | null;
  tags: string[];
  images: string[];
  videoUrl: string | null;
  brewMethod: string | null;
  waterTemp: number | null;
  teaWeight: string | null;
  steepCount: number | null;
  status: string;
  createdAt: string;
  author: AuthorInfo;
  tea: TeaInfo | null;
  board: BoardInfo | null;
}

export interface SourceNote {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  source: string;
  brewMethod: string | null;
  waterTemp: number | null;
  teaWeight: string | null;
  steepCount: number | null;
  images: unknown; // Json column
  videoUrl: string | null;
  createdAt: string;
  tea: TeaInfo | null;
  author: AuthorInfo;
}

function asImages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === "string");
}

function teaLabel(tea: TeaInfo | null): string {
  if (!tea) return "—";
  return [tea.brand, tea.name, tea.year].filter(Boolean).join(" · ");
}

interface Props {
  draft: ReviewDraft;
  sourceNote: SourceNote | null;
  onClose: () => void;
  onChanged: () => void;
}

export default function DraftReviewPanel({ draft, sourceNote, onClose, onChanged }: Props) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(draft.title);
  const [content, setContent] = useState(draft.content);
  const [images, setImages] = useState<string[]>(asImages(draft.images));
  const [uploadingImg, setUploadingImg] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Reset local edit state when the inspected draft changes.
  useEffect(() => {
    setEditing(false);
    setTitle(draft.title);
    setContent(draft.content);
    setImages(asImages(draft.images));
  }, [draft.id]);

  const isTeaDraft = isTastingDraftId(draft.id);
  const draftImages = Array.isArray(draft.images) ? draft.images : [];
  const noteImages = sourceNote ? asImages(sourceNote.images) : [];
  const hasBrew =
    !!(draft.brewMethod || draft.waterTemp || draft.teaWeight || draft.steepCount != null);

  // Video sync hints (policy implemented server-side in draft-media.ts).
  const imagesDirty = images.join(" ") !== asImages(draft.images).join(" ");
  const videoWillClear = imagesDirty && images.length < 4 && !!draft.videoUrl;
  const videoWillRegen = imagesDirty && images.length >= 4;

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/drafts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: draft.id, title, content, images }),
      });
      if (!res.ok) throw new Error(await res.text());
      const saved = await res.json().catch(() => null);
      if (saved?.videoRegenFailed) {
        alert("图片已保存，但轮播视频重新生成失败——保留了旧视频，可重试保存或手动处理。");
      }
      setEditing(false);
      onChanged();
    } catch (err) {
      alert("保存失败: " + (err instanceof Error ? err.message : "未知错误"));
    } finally {
      setSaving(false);
    }
  }

  async function uploadImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (!allowed.includes(file.type)) {
      alert("只支持 JPG、PNG、GIF、WebP 格式");
      e.target.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert("图片大小不能超过 5MB");
      e.target.value = "";
      return;
    }
    setUploadingImg(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      if (!res.ok) throw new Error(await res.text());
      const { url } = await res.json();
      if (typeof url === "string" && url) setImages((prev) => [...prev, url]);
    } catch (err) {
      alert("上传失败: " + (err instanceof Error ? err.message : "未知错误"));
    } finally {
      setUploadingImg(false);
      e.target.value = "";
    }
  }

  async function transition(status: "published" | "archived") {
    const verb = status === "published" ? "发布" : "归档";
    if (!confirm(`确定${verb}该草稿？`)) return;
    setBusy(status);
    try {
      const res = await fetch("/api/drafts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: draft.id, status }),
      });
      if (!res.ok) throw new Error(await res.text());
      onChanged();
      onClose();
    } catch (err) {
      alert(`${verb}失败: ` + (err instanceof Error ? err.message : "未知错误"));
    } finally {
      setBusy(null);
    }
  }

  async function del() {
    if (!confirm("确定删除该草稿？此操作不可撤销。")) return;
    setBusy("delete");
    try {
      const res = await fetch("/api/drafts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: draft.id }),
      });
      if (!res.ok) throw new Error(await res.text());
      onChanged();
      onClose();
    } catch (err) {
      alert("删除失败: " + (err instanceof Error ? err.message : "未知错误"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm z-50 flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-stone-50 rounded-xl shadow-2xl max-w-3xl w-full my-8"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200 bg-white rounded-t-xl sticky top-0 z-10">
          <div className="min-w-0">
            <h2 className="text-lg font-serif font-bold text-stone-800">草稿审校</h2>
            <p className="text-xs text-stone-400 font-mono mt-0.5 truncate">{draft.id}</p>
          </div>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-700 text-xl leading-none px-2"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Trust banner: tasting-draft provenance */}
          {isTeaDraft && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">
              <p className="font-medium">自动组稿 · 未调用 AI、未做语义改写</p>
              <p className="text-xs text-amber-800/80 mt-1">
                正文为原作者本人品鉴笔记的逐字取舍（仅删空段/重复段/导入样板）。如需核对，请逐段对照下方「来源笔记」。
              </p>
            </div>
          )}

          {/* Metadata */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
            <Meta label="作者" value={draft.author?.username ?? "—"} />
            <Meta label="茶品" value={teaLabel(draft.tea)} />
            <Meta label="版块" value={draft.board?.name ?? "—"} />
            <Meta
              label="创建时间"
              value={new Date(draft.createdAt).toLocaleString("zh-CN")}
            />
            <Meta label="类型" value={draft.type === "tasting" ? "品鉴" : draft.type} />
            <Meta label="标签" value={draft.tags?.length ? draft.tags.join(", ") : "—"} />
          </div>

          {/* Brew params */}
          {hasBrew && (
            <div className="text-sm text-stone-600 bg-white border border-stone-200 rounded-lg px-4 py-3">
              <span className="text-stone-400">冲泡记录：</span>
              {[
                draft.brewMethod,
                draft.waterTemp != null ? `${draft.waterTemp}℃` : null,
                draft.teaWeight,
                draft.steepCount != null ? `${draft.steepCount}泡` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}

          {/* Media preview */}
          {(draftImages.length > 0 || draft.videoUrl) && (
            <div>
              <SectionTitle>媒体（{draftImages.length} 图{draft.videoUrl ? " · 含视频" : ""}）</SectionTitle>
              {draftImages.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {draftImages.slice(0, 8).map((src, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={i}
                      src={src}
                      alt={`图 ${i + 1}`}
                      className="w-20 h-20 object-cover rounded border border-stone-200"
                    />
                  ))}
                </div>
              )}
              {draft.videoUrl && (
                <video
                  src={draft.videoUrl}
                  controls
                  className="mt-2 max-h-48 rounded border border-stone-200"
                />
              )}
            </div>
          )}

          {/* Body: view or edit */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <SectionTitle>正文</SectionTitle>
              {!editing && (
                <button
                  onClick={() => setEditing(true)}
                  className="text-xs text-amber-700 hover:text-amber-900 font-medium"
                >
                  ✏️ 编辑
                </button>
              )}
            </div>

            {editing ? (
              <div className="space-y-3">
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

                {/* Image manager: delete thumbnails / upload additions.
                    Server keeps the slideshow video consistent on save. */}
                <div>
                  <span className="text-xs text-stone-500">
                    图片（{images.length} 张）— 点 ✕ 删除，点 ＋ 上传新图
                  </span>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {images.map((src, i) => (
                      <div key={`${i}-${src}`} className="relative">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={src}
                          alt={`图 ${i + 1}`}
                          className="w-20 h-20 object-cover rounded border border-stone-200"
                        />
                        <button
                          type="button"
                          onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                          className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-600 text-white text-xs leading-none shadow hover:bg-red-700"
                          aria-label={`删除图 ${i + 1}`}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <label className="w-20 h-20 flex items-center justify-center rounded border border-dashed border-stone-300 text-stone-400 hover:border-amber-500 hover:text-amber-600 cursor-pointer text-xl">
                      {uploadingImg ? "…" : "＋"}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/gif,image/webp"
                        className="hidden"
                        onChange={uploadImage}
                        disabled={uploadingImg}
                      />
                    </label>
                  </div>
                  {videoWillClear && (
                    <p className="mt-1.5 text-xs text-red-600">
                      ⚠️ 图片少于 4 张：保存后将清除轮播视频（发布后详情页仅显示正文文字）。
                    </p>
                  )}
                  {videoWillRegen && (
                    <p className="mt-1.5 text-xs text-amber-700">
                      图片有改动：保存时将自动重新生成轮播视频（可能需要几秒）。
                    </p>
                  )}
                </div>

                <RichEditor value={content} onChange={setContent} />
                <div className="flex gap-2">
                  <button
                    onClick={save}
                    disabled={saving}
                    className="text-xs bg-amber-700 text-white px-4 py-2 rounded-lg hover:bg-amber-800 disabled:opacity-50"
                  >
                    {saving ? "保存中…" : "保存"}
                  </button>
                  <button
                    onClick={() => {
                      setEditing(false);
                      setTitle(draft.title);
                      setContent(draft.content);
                      setImages(asImages(draft.images));
                    }}
                    className="text-xs text-stone-500 hover:text-stone-700 px-4 py-2"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div
                className="prose prose-stone prose-sm max-w-none bg-white border border-stone-200 rounded-lg px-4 py-3"
                dangerouslySetInnerHTML={{ __html: draft.content || "<p class='text-stone-400'>（空）</p>" }}
              />
            )}
          </div>

          {/* Source note (tasting drafts only) */}
          {sourceNote && (
            <div className="border-t border-stone-200 pt-4">
              <div className="flex items-center justify-between mb-2">
                <SectionTitle>
                  来源笔记
                  <span className="text-stone-400 font-normal ml-2">source={sourceNote.source}</span>
                </SectionTitle>
                <a
                  href={`/tasting/${sourceNote.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-amber-700 hover:text-amber-900 font-medium"
                >
                  打开原笔记 ↗
                </a>
              </div>
              <div
                className="prose prose-stone prose-sm max-w-none bg-stone-100 border border-stone-200 rounded-lg px-4 py-3"
                dangerouslySetInnerHTML={{ __html: sourceNote.content || "<p class='text-stone-400'>（空）</p>" }}
              />
              {noteImages.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {noteImages.slice(0, 8).map((src, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={i}
                      src={src}
                      alt={`原笔记图 ${i + 1}`}
                      className="w-16 h-16 object-cover rounded border border-stone-200 opacity-80"
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-stone-200 bg-white rounded-b-xl sticky bottom-0">
          {/* While editing, the in-memory title/content differ from what is
              saved. Force a save (or cancel) before any state transition so a
              publish can never ship the pre-edit body by surprise. */}
          {editing && (
            <span className="mr-auto text-xs text-amber-700">
              编辑中 — 请先保存或取消后再发布/归档
            </span>
          )}
          <button
            onClick={del}
            disabled={busy !== null || editing}
            className="text-xs text-stone-400 hover:text-red-500 px-3 py-2 disabled:opacity-50"
          >
            {busy === "delete" ? "删除中…" : "删除"}
          </button>
          <button
            onClick={() => transition("archived")}
            disabled={busy !== null || editing}
            className="text-xs text-stone-600 border border-stone-300 px-4 py-2 rounded-lg hover:bg-stone-100 disabled:opacity-50"
          >
            {busy === "archived" ? "归档中…" : "归档"}
          </button>
          <button
            onClick={() => transition("published")}
            disabled={busy !== null || editing}
            title={editing ? "请先保存或取消编辑" : undefined}
            className="text-xs bg-amber-700 text-white px-5 py-2 rounded-lg hover:bg-amber-800 disabled:opacity-50"
          >
            {busy === "published" ? "发布中…" : "发布"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-stone-400">{label}</dt>
      <dd className="text-stone-800 truncate">{value}</dd>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-medium text-stone-700">{children}</h3>;
}
