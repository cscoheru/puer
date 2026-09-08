"use client";

import { useState, useRef } from "react";

interface Props {
  value: string[];
  onChange: (urls: string[]) => void;
  maxImages?: number;
}

export default function ImageUploadGrid({ value, onChange, maxImages = 9 }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const remaining = maxImages - value.length;
    const batch = files.slice(0, remaining);
    if (batch.length === 0) return;

    setUploading(true);
    const urls = await Promise.all(
      batch.map(async (file) => {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("category", "session");
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        if (!res.ok) throw new Error("上传失败");
        const { url } = await res.json();
        return url as string;
      })
    );
    onChange([...value, ...urls]);
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const remove = (index: number) => onChange(value.filter((_, i) => i !== index));

  const move = (index: number, dir: -1 | 1) => {
    const next = [...value];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div>
      <div className="grid grid-cols-3 gap-2">
        {value.map((url, i) => (
          <div key={url} className="relative aspect-square rounded-lg overflow-hidden border border-amber-200 bg-amber-50 group">
            <img src={url} alt="" className="w-full h-full object-cover" />
            {i === 0 && (
              <span className="absolute top-1 left-1 text-[10px] bg-amber-600 text-white px-1.5 py-0.5 rounded font-medium">
                封面
              </span>
            )}
            <button
              type="button"
              onClick={() => remove(i)}
              className="absolute top-1 right-1 w-5 h-5 bg-red-500 text-white rounded-full text-[10px] opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 flex items-center justify-center"
            >
              ✕
            </button>
            {value.length > 1 && (
              <div className="absolute bottom-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                {i > 0 && (
                  <button type="button" onClick={() => move(i, -1)} className="w-5 h-5 bg-white/80 rounded text-[10px] hover:bg-white flex items-center justify-center">▲</button>
                )}
                {i < value.length - 1 && (
                  <button type="button" onClick={() => move(i, 1)} className="w-5 h-5 bg-white/80 rounded text-[10px] hover:bg-white flex items-center justify-center">▼</button>
                )}
              </div>
            )}
          </div>
        ))}
        {value.length < maxImages && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="aspect-square rounded-lg border-2 border-dashed border-amber-300 hover:border-amber-500 flex items-center justify-center text-amber-400 hover:text-amber-600 transition disabled:opacity-50"
          >
            {uploading ? (
              <div className="w-6 h-6 border-2 border-amber-600 border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            )}
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        multiple
        className="hidden"
        onChange={handleSelect}
      />
      <p className="text-xs text-stone-400 mt-1.5">第一张为封面，最多 {maxImages} 张</p>
    </div>
  );
}
