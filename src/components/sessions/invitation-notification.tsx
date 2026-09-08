"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { WS_EVENTS } from "@/lib/session-constants";

interface InvitationData {
  id: string;
  title: string;
  teaName: string;
  coverImage: string | null;
  scheduledAt: string;
  duration: number;
  host: { id: string; username: string; avatar: string | null; level: number };
}

interface ToastItem {
  key: string;
  invitation: InvitationData;
  fading: boolean;
}

function formatTime(dateStr: string) {
  const d = new Date(dateStr);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hour = d.getHours().toString().padStart(2, "0");
  const min = d.getMinutes().toString().padStart(2, "0");
  return `${month}月${day}日 ${hour}:${min}`;
}

export default function InvitationNotification() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    function handler(e: Event) {
      const { session } = (e as CustomEvent).detail;
      if (!session) return;
      const key = `${session.id}-${Date.now()}`;
      setToasts((prev) => [...prev.slice(-4), { key, invitation: session, fading: false }]);

      setTimeout(() => {
        setToasts((prev) =>
          prev.map((t) => (t.key === key ? { ...t, fading: true } : t))
        );
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.key !== key));
        }, 400);
      }, 8000);
    }

    window.addEventListener("tea-invitation", handler);
    return () => window.removeEventListener("tea-invitation", handler);
  }, []);

  const dismiss = useCallback((key: string) => {
    setToasts((prev) => prev.filter((t) => t.key !== key));
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.key}
          className={`pointer-events-auto bg-white border border-amber-200 rounded-lg shadow-lg overflow-hidden transition-all duration-300 ${
            t.fading ? "opacity-0 translate-x-4" : "opacity-100 translate-x-0"
          }`}
        >
          <div className="flex gap-3 p-3">
            {t.invitation.coverImage && (
              <img
                src={t.invitation.coverImage}
                alt=""
                className="w-16 h-16 rounded object-cover shrink-0"
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs text-amber-700 font-medium mb-0.5">
                🍵 {t.invitation.host.username} 邀请你参加茶会
              </p>
              <Link
                href={`/sessions/${t.invitation.id}`}
                className="text-sm font-semibold text-stone-800 hover:text-amber-800 line-clamp-1"
              >
                {t.invitation.title}
              </Link>
              <p className="text-xs text-stone-400 mt-0.5">
                {t.invitation.teaName} · {formatTime(t.invitation.scheduledAt)} · {t.invitation.duration}分钟
              </p>
              <div className="flex gap-2 mt-2">
                <Link
                  href={`/sessions/${t.invitation.id}`}
                  className="text-xs px-3 py-1 bg-amber-600 text-white rounded hover:bg-amber-700 transition"
                >
                  查看详情
                </Link>
                <button
                  onClick={() => dismiss(t.key)}
                  className="text-xs px-3 py-1 text-stone-400 hover:text-stone-600 transition"
                >
                  忽略
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
