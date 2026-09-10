"use client";

import { useState, useRef, useEffect } from "react";
import { Socket } from "socket.io-client";
import { WS_EVENTS } from "@/lib/session-constants";

interface GalleryEntry {
  id: string;
  steepNumber: number;
  imageUrl: string;
  description: string | null;
  createdAt: string;
}

interface Props {
  socket: Socket | null;
  sessionId: string;
  steepCount: number;
  isHost: boolean;
  isLive: boolean;
  initialGallery: GalleryEntry[];
}

export default function BrewPanel({
  socket,
  sessionId,
  steepCount,
  isHost,
  isLive,
  initialGallery,
}: Props) {
  const [gallery, setGallery] = useState<GalleryEntry[]>(initialGallery);
  const [showForm, setShowForm] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!socket) return;

    const handler = (data: GalleryEntry & { type: string }) => {
      setGallery((prev) => {
        if (prev.some((g) => g.id === data.id)) return prev;
        return [...prev, data];
      });
    };

    socket.on(WS_EVENTS.BREW_UPDATED, handler);
    return () => {
      socket.off(WS_EVENTS.BREW_UPDATED, handler);
    };
  }, [socket]);

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("category", "session");
    try {
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      if (res.ok) {
        const { url } = await res.json();
        setImageUrl(url);
      }
    } catch {
      // silent
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const recordBrew = async () => {
    if (!socket || saving) return;
    setSaving(true);
    socket.emit(WS_EVENTS.BREW_UPDATE, {
      sessionId,
      imageUrl: imageUrl || undefined,
      description: description || undefined,
    });
    setImageUrl("");
    setDescription("");
    setShowForm(false);
    setSaving(false);
  };

  const resetForm = () => {
    setShowForm(false);
    setImageUrl("");
    setDescription("");
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-amber-100 flex items-center justify-between">
        <h3 className="font-semibold text-stone-700">冲泡记录</h3>
        {isHost && isLive && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="text-sm text-amber-600 hover:text-amber-700 font-medium"
          >
            + 记录
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {showForm && (
          <div className="bg-amber-50 rounded-lg p-3 space-y-2">
            <p className="text-sm font-medium text-stone-700">
              第 {steepCount + 1} 泡
            </p>

            {/* Image upload */}
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                className="hidden"
                onChange={handleImageSelect}
              />
              {imageUrl ? (
                <div className="relative inline-block">
                  <img src={imageUrl} alt="" className="h-20 rounded-lg object-cover" />
                  <button
                    type="button"
                    onClick={() => setImageUrl("")}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 text-white rounded-full text-[0.625rem] flex items-center justify-center"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-1.5 px-3 py-2 border border-amber-300 rounded-lg text-sm text-stone-500 hover:text-amber-700 hover:border-amber-500 transition disabled:opacity-50"
                >
                  {uploading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-amber-600 border-t-transparent rounded-full animate-spin" />
                      上传中...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      选择图片
                    </>
                  )}
                </button>
              )}
            </div>

            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="口感描述..."
              rows={2}
              className="w-full px-2 py-1.5 border border-amber-200 rounded text-sm resize-none"
            />
            <div className="flex gap-2">
              <button
                onClick={recordBrew}
                disabled={saving || uploading}
                className="px-3 py-1.5 bg-amber-600 text-white rounded text-sm hover:bg-amber-700 disabled:opacity-50"
              >
                记录
              </button>
              <button
                onClick={resetForm}
                className="px-3 py-1.5 text-stone-500 text-sm"
              >
                取消
              </button>
            </div>
          </div>
        )}

        {gallery.length === 0 ? (
          <div className="text-center py-8 text-stone-400 text-sm">
            还没有冲泡记录
          </div>
        ) : (
          gallery.map((entry) => (
            <div key={entry.id} className="flex gap-3 items-start">
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-sm font-bold text-amber-700 flex-shrink-0">
                {entry.steepNumber}
              </div>
              <div className="min-w-0">
                <p className="text-xs text-stone-400">
                  第 {entry.steepNumber} 泡
                </p>
                {entry.imageUrl && (
                  <img
                    src={entry.imageUrl}
                    alt=""
                    className="mt-1 max-w-32 rounded-lg"
                  />
                )}
                {entry.description && (
                  <p className="text-sm text-stone-600 mt-1">{entry.description}</p>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
