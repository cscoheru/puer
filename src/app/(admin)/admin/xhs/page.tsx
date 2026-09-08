"use client";

import { useState, useEffect, useCallback } from "react";

interface VideoPost {
  id: string;
  title: string;
  videoUrl: string;
  createdAt: string;
  upvotes: number;
  author: { username: string };
}

export default function XhsPage() {
  const [hot, setHot] = useState<VideoPost[]>([]);
  const [latest, setLatest] = useState<VideoPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/xhs");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setHot(data.hot || []);
      setLatest(data.latest || []);
    } catch {
      setError("加载失败,请重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const renderPost = (p: VideoPost) => (
    <div
      key={p.id}
      className="rounded-lg border border-stone-200 bg-white p-3 flex gap-3"
    >
      <video
        src={p.videoUrl}
        controls
        playsInline
        className="w-28 h-28 rounded bg-stone-100 shrink-0 object-cover"
      />
      <div className="min-w-0 flex-1 flex flex-col">
        <p className="text-sm text-stone-800 line-clamp-2 break-words">
          {p.title}
        </p>
        <p className="text-xs text-stone-400 mt-1">
          @{p.author?.username} · 👍 {p.upvotes}
        </p>
        <div className="mt-auto flex flex-wrap gap-2">
          <a
            href={`/api/admin/videos/${p.id}/download`}
            download
            className="px-3 py-1.5 rounded text-xs font-medium bg-amber-600 text-white hover:bg-amber-700"
          >
            ⬇ 水印版
          </a>
          <a
            href={`/api/admin/videos/${p.id}/download?raw=1`}
            download
            className="px-3 py-1.5 rounded text-xs font-medium bg-stone-700 text-white hover:bg-stone-800"
          >
            ⬇ 无水印版
          </a>
          <a
            href={`/forum/thread/${p.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 rounded text-xs font-medium border border-stone-300 text-stone-600 hover:bg-stone-50"
          >
            📄 原帖
          </a>
        </div>
      </div>
    </div>
  );

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-stone-800">📕 视频下载</h1>
        <p className="text-sm text-stone-500 mt-1">
          热榜和最新帖子里的视频,一键下载后分享到小红书。仅管理员可下载。
        </p>
      </header>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-stone-400">加载中…</p>
      ) : (
        <>
          <section>
            <h2 className="text-sm font-semibold text-stone-600 mb-3">
              🔥 热榜视频({hot.length})
            </h2>
            {hot.length === 0 ? (
              <p className="text-sm text-stone-400">暂无</p>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {hot.map(renderPost)}
              </div>
            )}
          </section>

          <section>
            <h2 className="text-sm font-semibold text-stone-600 mb-3">
              🆕 最新视频({latest.length})
            </h2>
            {latest.length === 0 ? (
              <p className="text-sm text-stone-400">暂无</p>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {latest.map(renderPost)}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
