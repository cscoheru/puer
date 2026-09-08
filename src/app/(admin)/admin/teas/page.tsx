"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface Tea {
  id: string;
  name: string;
  brand: string;
  year: number;
  type: string;
  tastingNoteCount: number;
}

function normalize(s: string) {
  return s.replace(/[\s\-_（）()\[\]【】「」,，.。]+/g, "").toLowerCase();
}

function similarity(a: string, b: string) {
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length < b.length ? a : b;
  if (longer.length === 0) return 1;
  const matches = [...shorter].filter((c, i) => c === longer[i]).length;
  return matches / longer.length;
}

export default function AdminTeasPage() {
  const [teas, setTeas] = useState<Tea[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [threshold, setThreshold] = useState(0.65);

  useEffect(() => {
    fetch("/api/teas?limit=9999")
      .then((r) => r.json())
      .then((data) => setTeas(data.teas || []))
      .catch(() => setMessage("加载失败"))
      .finally(() => setLoading(false));
  }, []);

  // Find potential duplicates
  const pairs: [Tea, Tea, number][] = [];
  for (let i = 0; i < teas.length; i++) {
    for (let j = i + 1; j < teas.length; j++) {
      const score = similarity(normalize(teas[i].name), normalize(teas[j].name));
      if (score >= threshold) {
        pairs.push([teas[i], teas[j], score]);
      }
    }
  }
  pairs.sort((a, b) => b[2] - a[2]);

  const handleMerge = async (keepId: string, removeId: string) => {
    if (!confirm("品鉴笔记将转移到保留茶品，此操作不可撤销。确定合并？")) return;
    setMessage("合并中...");
    try {
      const res = await fetch("/api/admin/teas/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepId, removeId }),
      });
      if (res.ok) {
        setMessage("合并成功");
        setTeas((prev) => prev.filter((t) => t.id !== removeId));
      } else {
        const err = await res.json();
        setMessage(err.error || "合并失败");
      }
    } catch {
      setMessage("合并失败");
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/forum" className="hover:text-amber-700 transition">品茶论坛</Link>
        <span className="mx-2">/</span>
        <Link href="/admin/drafts" className="hover:text-amber-700 transition">管理后台</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">茶品合并</span>
      </nav>

      <h1 className="text-2xl font-serif font-bold text-stone-800 mb-2">茶品合并工具</h1>
      <p className="text-sm text-stone-500 mb-6">
        共 {teas.length} 个茶品，找到 {pairs.length} 对疑似重复
      </p>

      <div className="mb-4 flex items-center gap-3">
        <label className="text-sm text-stone-600">相似度阈值:</label>
        <input
          type="range"
          min="0.4"
          max="1"
          step="0.05"
          value={threshold}
          onChange={(e) => setThreshold(parseFloat(e.target.value))}
          className="w-32"
        />
        <span className="text-sm text-stone-500">{threshold.toFixed(2)}</span>
      </div>

      {message && (
        <p className="mb-4 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">{message}</p>
      )}

      {loading ? (
        <p className="text-stone-400 text-sm py-8 text-center">加载中...</p>
      ) : pairs.length > 0 ? (
        <div className="space-y-3">
          {pairs.map(([a, b, score], i) => (
            <div key={i} className="bg-white border border-stone-200 rounded-xl p-4 flex items-center gap-4">
              <div className="flex-1">
                <Link href={`/tea/${a.id}`} className="font-medium text-stone-800 hover:text-amber-700 text-sm">{a.name}</Link>
                <div className="text-xs text-stone-400 mt-0.5">{a.brand} · {a.year} · {a.tastingNoteCount} 篇</div>
              </div>
              <div className="text-xs text-stone-400 px-2">≈ {(score * 100).toFixed(0)}%</div>
              <div className="flex-1">
                <Link href={`/tea/${b.id}`} className="font-medium text-stone-800 hover:text-amber-700 text-sm">{b.name}</Link>
                <div className="text-xs text-stone-400 mt-0.5">{b.brand} · {b.year} · {b.tastingNoteCount} 篇</div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleMerge(a.id, b.id)}
                  className="px-3 py-1.5 text-xs bg-amber-800 text-white rounded-lg hover:bg-amber-900 transition"
                >
                  左←右
                </button>
                <button
                  onClick={() => handleMerge(b.id, a.id)}
                  className="px-3 py-1.5 text-xs bg-stone-700 text-white rounded-lg hover:bg-stone-800 transition"
                >
                  右←左
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-stone-400 text-sm py-8 text-center">暂未发现重复茶品</p>
      )}
    </div>
  );
}
