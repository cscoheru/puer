"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";

interface Props {
  receiverId: string;
  receiverName: string;
  onClose: () => void;
  onSent?: () => void;
}

export default function MessageDialog({ receiverId, receiverName, onClose, onSent }: Props) {
  const { data: session } = useSession();
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  if (!session?.user) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
        <div className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 p-6" onClick={(e) => e.stopPropagation()}>
          <p className="text-sm text-stone-500">请先登录后留言</p>
          <div className="flex gap-2 mt-4">
            <Link href="/login" className="flex-1 bg-amber-600 text-white py-2 rounded-lg text-sm text-center hover:bg-amber-700 transition">去登录</Link>
            <button onClick={onClose} className="px-4 border border-stone-300 text-stone-600 py-2 rounded-lg text-sm hover:bg-stone-50 transition">关闭</button>
          </div>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSending(true);

    try {
      const res = await fetch("/api/user/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiverId, content }),
      });
      const data = await res.json();
      if (res.ok) {
        setDone(true);
        onSent?.();
      } else {
        setError(data.error || "发送失败");
      }
    } catch {
      setError("网络错误");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 p-6" onClick={(e) => e.stopPropagation()}>
        {done ? (
          <div className="text-center py-4">
            <p className="text-green-600 text-lg mb-2">✅ 留言已发送</p>
            <p className="text-sm text-stone-500 mb-4">静候对方回复</p>
            <button onClick={onClose} className="px-6 py-2 bg-stone-800 text-white rounded-lg text-sm hover:bg-stone-900 transition">关闭</button>
          </div>
        ) : (
          <>
            <h2 className="text-lg font-bold text-stone-800 mb-1">发给 {receiverName}</h2>
            <p className="text-xs text-stone-400 mb-4">请勿留下电话号码或微信号，系统会自动拦截</p>

            <form onSubmit={handleSubmit} className="space-y-3">
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                required
                rows={4}
                maxLength={50}
                className="w-full border border-stone-300 rounded-lg px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                placeholder={`想对${receiverName}说什么...（限50字）`}
              />
              <p className="text-xs text-stone-400 text-right">{content.length}/50</p>

              {error && <p className="text-xs text-red-500">{error}</p>}

              <div className="flex gap-2">
                <button type="button" onClick={onClose}
                  className="flex-1 border border-stone-300 text-stone-600 py-2 rounded-lg text-sm hover:bg-stone-50 transition">取消</button>
                <button type="submit" disabled={sending || !content.trim()}
                  className="flex-1 bg-amber-600 text-white py-2 rounded-lg text-sm hover:bg-amber-700 transition disabled:opacity-50">
                  {sending ? "发送中..." : "发送"}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
