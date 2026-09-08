"use client";

import { SESSION_STATUS, BREW_METHODS, type SessionStatus } from "@/lib/session-constants";
import SessionCountdown from "./session-countdown";
import InvitationList from "./invitation-list";

interface Props {
  session: {
    id: string;
    title: string;
    teaName: string;
    description: string | null;
    coverImage: string | null;
    images: string[];
    brewMethod: string | null;
    waterTemp: number | null;
    teaWeight: string | null;
    status: string;
    steepCount: number;
    hostId: string;
    viewerCount: number;
    peakParticipants: number;
    duration: number | null;
    publishedArticleId: string | null;
    participantCount: number;
    startedAt: string | null;
    scheduledAt: string | null;
    endedAt: string | null;
  };
  host: { id: string; username: string; avatar: string | null; level: number };
  tea: { name: string; year: number | null; type: string | null } | null;
  currentUserId?: string;
  onStart?: () => void;
  onEnd?: () => void;
  onPublish?: () => void;
  starting?: boolean;
  ending?: boolean;
  publishing?: boolean;
}

export default function SessionInfoCard({
  session,
  host,
  tea,
  currentUserId,
  onStart,
  onEnd,
  onPublish,
  starting,
  ending,
  publishing,
}: Props) {
  const isHost = currentUserId === session.hostId;
  const st = SESSION_STATUS[session.status as SessionStatus] ?? SESSION_STATUS.live;
  const brewLabel = BREW_METHODS.find((m) => m.value === session.brewMethod)?.label;
  const isConfirmed = session.status === "confirmed";
  const isInviting = session.status === "inviting";
  const isLive = session.status === "live";
  const isEnded = session.status === "ended";
  const showInvitations = isInviting || isConfirmed;
  const coverImage = session.coverImage || session.images?.[0];

  const handleExpired = () => {
    // Session expired — the parent component handles this via UI refresh
    window.location.reload();
  };

  return (
    <div className="bg-white rounded-xl border border-amber-100 overflow-hidden">
      {/* Cover */}
      <div className="h-32 bg-gradient-to-br from-amber-50 to-stone-100 relative">
        {coverImage ? (
          <img src={coverImage} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-5xl">🍵</div>
        )}
        <span className={`absolute top-2 left-2 text-xs font-medium px-2 py-0.5 rounded-full ${st.color}`}>
          {st.label}
        </span>

        {/* Countdown overlay for confirmed sessions */}
        {isConfirmed && session.scheduledAt && (
          <div className="absolute bottom-2 left-2 bg-black/60 text-white text-xs px-2 py-1 rounded-lg">
            <SessionCountdown targetDate={session.scheduledAt} onExpired={handleExpired} />
          </div>
        )}
      </div>

      <div className="p-4 space-y-3">
        <h2 className="font-bold text-stone-800 text-lg">{session.title}</h2>

        {session.description && (
          <p className="text-sm text-stone-500 leading-relaxed">{session.description}</p>
        )}

        {/* Tea info */}
        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <span className="text-stone-400">茶品</span>
            <span className="text-stone-700 font-medium">{session.teaName}</span>
          </div>
          {tea?.year && (
            <div className="flex justify-between">
              <span className="text-stone-400">年份</span>
              <span className="text-stone-600">{tea.year}</span>
            </div>
          )}
          {brewLabel && (
            <div className="flex justify-between">
              <span className="text-stone-400">泡法</span>
              <span className="text-stone-600">{brewLabel}</span>
            </div>
          )}
          {session.waterTemp && (
            <div className="flex justify-between">
              <span className="text-stone-400">水温</span>
              <span className="text-stone-600">{session.waterTemp}℃</span>
            </div>
          )}
          {session.teaWeight && (
            <div className="flex justify-between">
              <span className="text-stone-400">投茶量</span>
              <span className="text-stone-600">{session.teaWeight}</span>
            </div>
          )}
          {session.duration && (
            <div className="flex justify-between">
              <span className="text-stone-400">时长</span>
              <span className="text-stone-600">{session.duration} 分钟</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-stone-400">冲泡次数</span>
            <span className="text-stone-600">{session.steepCount} 泡</span>
          </div>
          {session.scheduledAt && (
            <div className="flex justify-between">
              <span className="text-stone-400">预约时间</span>
              <span className="text-stone-600">{new Date(session.scheduledAt).toLocaleString("zh-CN")}</span>
            </div>
          )}
        </div>

        {/* Participant info */}
        {(session.viewerCount > 0 || session.peakParticipants > 0) && (
          <div className="pt-1 text-xs text-stone-400 space-y-0.5">
            {session.peakParticipants > 0 && (
              <p>最高在线: {session.peakParticipants} 人</p>
            )}
          </div>
        )}

        {/* Host */}
        <div className="flex items-center gap-2 pt-2 border-t border-amber-50">
          <img
            src={host.avatar || "/default-avatar.svg"}
            alt=""
            className="w-8 h-8 rounded-full object-cover"
          />
          <div>
            <p className="text-sm font-medium text-stone-700">{host.username}</p>
            <p className="text-xs text-stone-400">Lv.{host.level}</p>
          </div>
        </div>

        {/* Invitations list */}
        {showInvitations && (
          <div className="pt-1">
            <InvitationList
              sessionId={session.id}
              currentUserId={currentUserId}
              hostId={session.hostId}
            />
          </div>
        )}

        {/* Actions */}
        {isConfirmed && isHost && onStart && (
          <button
            onClick={onStart}
            disabled={starting}
            className="w-full py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition text-sm font-medium disabled:opacity-50"
          >
            {starting ? "开席中..." : "进入茶席"}
          </button>
        )}

        {isLive && isHost && onEnd && (
          <button
            onClick={onEnd}
            disabled={ending}
            className="w-full py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition text-sm font-medium disabled:opacity-50"
          >
            {ending ? "结席中..." : "结席"}
          </button>
        )}

        {isEnded && isHost && onPublish && (
          <button
            onClick={onPublish}
            disabled={publishing}
            className="w-full py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition text-sm font-medium disabled:opacity-50"
          >
            {publishing ? "发布中..." : "发布到论坛"}
          </button>
        )}

        {/* Expired message */}
        {session.status === "expired" && (
          <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">
            <p className="font-medium">茶会已过期</p>
            <p className="text-xs mt-1">发起人未准时入席，请重新预约</p>
            {isHost && (
              <a
                href={`/sessions/new`}
                className="inline-block mt-2 px-3 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700"
              >
                重新预约
              </a>
            )}
          </div>
        )}

        {/* Published link */}
        {session.publishedArticleId && (
          <a
            href={`/forum/${session.publishedArticleId}`}
            className="block text-center py-2 bg-stone-50 text-amber-700 rounded-lg text-sm hover:bg-stone-100 transition"
          >
            查看论坛帖子 →
          </a>
        )}
      </div>
    </div>
  );
}
