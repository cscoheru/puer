"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewCommunityPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const generateSlug = (val: string) => {
    return val.toLowerCase().replace(/[^a-z0-9一-龥]+/g, "-").replace(/^-|-$/g, "");
  };

  const handleNameChange = (val: string) => {
    setName(val);
    if (!slug || slug === generateSlug(name)) {
      setSlug(generateSlug(val));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !slug.trim()) {
      setError("请填写社区名称和标识");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const res = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim(),
          description: description.trim() || undefined,
          icon: icon.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "创建失败");
      }

      const board = await res.json();
      router.push(`/forum/${board.slug}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-lg">
      <h1 className="text-lg font-bold text-stone-800 mb-1">创建新社区</h1>
      <p className="text-xs text-stone-400 mb-4">创建一个新的版块，让茶友们聚集讨论</p>

      <form onSubmit={handleSubmit} className="bg-white border border-stone-200 rounded-lg p-4 space-y-4">
        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
            {error}
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-stone-600 mb-1">社区名称</label>
          <input
            type="text"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="例如：普洱醇香"
            maxLength={50}
            required
            className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-stone-600 mb-1">
            社区标识 <span className="text-stone-400">（用于 URL，如 /forum/your-community）</span>
          </label>
          <div className="flex items-center gap-1 text-sm text-stone-400">
            <span>/forum/</span>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(generateSlug(e.target.value))}
              placeholder="pu-er-chun-xiang"
              maxLength={50}
              required
              className="flex-1 px-3 py-2 text-sm border border-stone-300 rounded-lg focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-stone-600 mb-1">图标（选填，emoji）</label>
          <input
            type="text"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            placeholder="🍵"
            maxLength={10}
            className="w-20 px-3 py-2 text-sm border border-stone-300 rounded-lg focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition text-center"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-stone-600 mb-1">描述（选填）</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="这个社区是讨论什么的？"
            rows={3}
            maxLength={200}
            className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition resize-none"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-2 bg-amber-800 hover:bg-amber-900 disabled:bg-stone-300 text-white text-sm font-medium rounded-lg transition"
        >
          {submitting ? "创建中..." : "创建社区"}
        </button>
      </form>
    </div>
  );
}
