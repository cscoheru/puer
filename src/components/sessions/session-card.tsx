"use client";

import Link from "next/link";
import { SESSION_STATUS, type SessionStatus } from "@/lib/session-constants";

interface SessionCardProps {
  id: string;
  title: string;
  teaName: string;
  coverImage: string | null;
  status: string;
  viewerCount: number;
  peakParticipants: number;
  _count: { messages: number };
  host: { id: string; username: string; avatar: string | null; level: number };
  tea: { name: string; year: number | null; type: string | null } | null;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export default function SessionCard({
  id,
  title,
  teaName,
  coverImage,
  status,
  viewerCount,
  peakParticipants,
  _count,
  host,
  tea,
  scheduledAt,
  startedAt,
  endedAt,
}: SessionCardProps) {
  const st = SESSION_STATUS[status as SessionStatus] ?? SESSION_STATUS.live;

  return (
    <Link
      href={`/sessions/${id}`}
      className="block bg-white rounded-xl border border-amber-100 overflow-hidden hover:shadow-md transition-shadow group"
    >
      {/* Cover image */}
      <div className="h-32 bg-gradient-to-br from-amber-50 to-stone-100 relative">
        {coverImage ? (
          <img
            src={coverImage}
            alt={title}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-4xl">
            🍵
          </div>
        )}
        <span
          className={`absolute top-2 left-2 text-xs font-medium px-2 py-0.5 rounded-full ${st.color}`}
        >
          {st.label}
        </span>
      </div>

      <div className="p-3 space-y-2">
        <h3 className="font-semibold text-stone-800 line-clamp-1 group-hover:text-amber-700 transition-colors">
          {title}
        </h3>

        <div className="flex items-center gap-2 text-xs text-stone-500">
          <span className="text-stone-700 font-medium">{teaName}</span>
          {tea?.year && <span>{tea.year}</span>}
        </div>

        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-1.5 text-xs text-stone-400">
            <img
              src={host.avatar || "/default-avatar.svg"}
              alt=""
              className="w-5 h-5 rounded-full object-cover"
            />
            <span>{host.username}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-stone-400">
            <span>{viewerCount || peakParticipants || 0} 人</span>
            <span>{_count.messages} 条消息</span>
          </div>
        </div>

        {scheduledAt && (
          <p className="text-xs text-amber-600">
            预定 {new Date(scheduledAt).toLocaleString("zh-CN")}
          </p>
        )}
        {startedAt && (
          <p className="text-xs text-stone-400">
            {new Date(startedAt).toLocaleString("zh-CN")}
          </p>
        )}
        {endedAt && (
          <p className="text-xs text-stone-400">
            {new Date(endedAt).toLocaleString("zh-CN")}
          </p>
        )}
      </div>
    </Link>
  );
}
