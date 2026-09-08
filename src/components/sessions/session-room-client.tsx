"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSocket } from "@/lib/socket";
import SessionInfoCard from "./session-info-card";
import ChatPanel from "./chat-panel";
import BrewPanel from "./brew-panel";
import GalleryWall from "./gallery-wall";
import SessionCountdown from "./session-countdown";
import InvitationList from "./invitation-list";

type InvitationUser = {
  id: string;
  username: string;
  avatar: string | null;
  level: number;
  onlineStatus: string;
};

type Invitation = {
  id: string;
  status: string;
  inviter: InvitationUser;
  invitee: InvitationUser;
  createdAt: string;
  respondedAt: string | null;
};

type TeaSessionData = {
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
  viewerCount: number;
  peakParticipants: number;
  teaGiftsCount: number;
  hostId: string;
  duration: number | null;
  publishedArticleId: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  host: { id: string; username: string; avatar: string | null; level: number };
  tea: { id: string; name: string; brand: string; year: number; type: string } | null;
  _count: { messages: number; participants: number; invitations: number };
  invitations: Invitation[];
  participantCount: number;
};

type MessageUser = { id: string; username: string; avatar: string | null; level: number };
type Message = {
  id: string;
  type: string;
  content: string | null;
  imageUrl: string | null;
  brewLog: unknown;
  giftType: string | null;
  userId: string;
  user: MessageUser;
  createdAt: string;
};
type GalleryEntry = {
  id: string;
  steepNumber: number;
  imageUrl: string;
  description: string | null;
  createdAt: string;
};

interface Props {
  session: TeaSessionData;
  initialMessages: Message[];
  initialGallery: GalleryEntry[];
  currentUser: { id: string; level: number } | null;
}

type MobileTab = "chat" | "brew" | "gallery";

export default function SessionRoomClient({
  session,
  initialMessages,
  initialGallery,
  currentUser,
}: Props) {
  const router = useRouter();
  const [sessionState, setSessionState] = useState(session);
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("chat");
  const [showInfo, setShowInfo] = useState(false);

  const { socket, connected } = useSocket({
    sessionId: sessionState.id,
    enabled: sessionState.status === "live" || sessionState.status === "confirmed",
  });

  const handleStart = useCallback(async () => {
    setStarting(true);
    try {
      const res = await fetch(`/api/sessions/${sessionState.id}/start`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "开席失败");
      } else {
        setSessionState((prev) => ({ ...prev, status: "live" }));
      }
    } catch {
      // silent
    }
    setStarting(false);
  }, [sessionState.id]);

  const handleEnd = useCallback(async () => {
    setEnding(true);
    try {
      const res = await fetch(`/api/sessions/${sessionState.id}/end`, {
        method: "POST",
      });
      if (!res.ok) throw new Error();
      setSessionState((prev) => ({ ...prev, status: "ended" }));
      router.refresh();
    } catch {
      // silent
    }
    setEnding(false);
  }, [sessionState.id, router]);

  const handlePublish = useCallback(async () => {
    setPublishing(true);
    try {
      const res = await fetch(`/api/sessions/${sessionState.id}/publish`, {
        method: "POST",
      });
      if (res.ok) {
        const data = await res.json();
        setSessionState((prev) => ({ ...prev, publishedArticleId: data.articleId }));
        router.refresh();
      } else {
        const data = await res.json();
        alert(data.error || "发布失败");
      }
    } catch {
      // silent
    }
    setPublishing(false);
  }, [sessionState.id, router]);

  const isHost = currentUser?.id === sessionState.hostId;
  const isLive = sessionState.status === "live";
  const isConfirmed = sessionState.status === "confirmed";
  const isInviting = sessionState.status === "inviting";
  const isEnded = sessionState.status === "ended";
  const canPublish = isHost && isEnded && !sessionState.publishedArticleId;

  const onExpired = useCallback(() => {
    setSessionState((prev) => ({ ...prev, status: "expired" }));
  }, []);

  return (
    <>
      {/* Desktop layout — 3 columns */}
      <div className="hidden md:block">
        <div className="flex gap-4 h-[calc(100vh-8rem)]">
          {/* Left: Info card */}
          <div className="w-72 flex-shrink-0 overflow-y-auto">
            <SessionInfoCard
              session={sessionState}
              host={sessionState.host}
              tea={sessionState.tea}
              currentUserId={currentUser?.id}
              onStart={handleStart}
              onEnd={handleEnd}
              onPublish={canPublish ? handlePublish : undefined}
              starting={starting}
              ending={ending}
              publishing={publishing}
            />
          </div>

          {/* Center: Chat */}
          <div className="flex-1 min-w-0 bg-white rounded-xl border border-amber-100 overflow-hidden flex flex-col">
            <div className="p-3 border-b border-amber-100">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-stone-700">聊天</h2>
                {isConfirmed && sessionState.scheduledAt && (
                  <SessionCountdown
                    targetDate={sessionState.scheduledAt}
                    onExpired={onExpired}
                  />
                )}
              </div>
            </div>
            <ChatPanel
              socket={socket}
              connected={connected}
              sessionId={sessionState.id}
              initialMessages={initialMessages}
              isLive={isLive}
              currentUser={
                currentUser
                  ? {
                      id: currentUser.id,
                      username: "",
                      avatar: null,
                      level: currentUser.level,
                    }
                  : null
              }
            />
          </div>

          {/* Right: Brew + Gallery */}
          <div className="w-72 flex-shrink-0 flex flex-col gap-4">
            <div className="bg-white rounded-xl border border-amber-100 overflow-hidden flex-1 flex flex-col">
              <BrewPanel
                socket={socket}
                sessionId={sessionState.id}
                steepCount={sessionState.steepCount}
                isHost={isHost}
                isLive={isLive}
                initialGallery={initialGallery}
              />
            </div>
            <div className="bg-white rounded-xl border border-amber-100 overflow-hidden">
              <div className="p-3 border-b border-amber-100">
                <h3 className="font-semibold text-stone-700">照片墙</h3>
              </div>
              <GalleryWall socket={socket} initialGallery={initialGallery} />
            </div>
          </div>
        </div>
      </div>

      {/* Mobile layout — collapsible info + tabbed panels */}
      <div className="md:hidden">
        <div className="flex flex-col h-[calc(100vh-8rem)]">
          {/* Collapsible info card */}
          <button
            onClick={() => setShowInfo(!showInfo)}
            className="flex items-center gap-2 px-3 py-2 bg-white border-b border-amber-100 text-left"
          >
            <span className="text-sm font-medium text-stone-700 truncate flex-1">
              {sessionState.title}
            </span>
            <span className="text-xs font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 flex-shrink-0">
              {sessionState.status === "live"
                ? "进行中"
                : sessionState.status === "confirmed"
                ? "即将开始"
                : sessionState.status === "ended"
                ? "已结束"
                : sessionState.status === "expired"
                ? "已过期"
                : sessionState.status === "inviting"
                ? "邀请中"
                : sessionState.status === "cancelled"
                ? "已取消"
                : "待开席"}
            </span>
            <svg
              className={`w-4 h-4 text-stone-400 transition-transform ${
                showInfo ? "rotate-180" : ""
              }`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showInfo && (
            <div className="bg-white border-b border-amber-100 max-h-64 overflow-y-auto">
              <div className="p-3">
                <SessionInfoCard
                  session={sessionState}
                  host={sessionState.host}
                  tea={sessionState.tea}
                  currentUserId={currentUser?.id}
                  onStart={handleStart}
                  onEnd={handleEnd}
                  onPublish={canPublish ? handlePublish : undefined}
                  starting={starting}
                  ending={ending}
                  publishing={publishing}
                />
              </div>
            </div>
          )}

          {/* Tab bar */}
          <div className="flex bg-white border-b border-amber-100">
            {[
              { key: "chat" as MobileTab, label: "聊天" },
              { key: "brew" as MobileTab, label: "冲泡" },
              { key: "gallery" as MobileTab, label: "照片墙" },
            ].map((t) => (
              <button
                key={t.key}
                onClick={() => setMobileTab(t.key)}
                className={`flex-1 py-2 text-sm font-medium text-center transition border-b-2 ${
                  mobileTab === t.key
                    ? "text-amber-700 border-amber-600"
                    : "text-stone-400 border-transparent"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden bg-white">
            {mobileTab === "chat" && (
              <ChatPanel
                socket={socket}
                connected={connected}
                sessionId={sessionState.id}
                initialMessages={initialMessages}
                isLive={isLive}
                currentUser={
                  currentUser
                    ? {
                        id: currentUser.id,
                        username: "",
                        avatar: null,
                        level: currentUser.level,
                      }
                    : null
                }
              />
            )}
            {mobileTab === "brew" && (
              <div className="h-full overflow-y-auto">
                <BrewPanel
                  socket={socket}
                  sessionId={sessionState.id}
                  steepCount={sessionState.steepCount}
                  isHost={isHost}
                  isLive={isLive}
                  initialGallery={initialGallery}
                />
              </div>
            )}
            {mobileTab === "gallery" && (
              <div className="h-full overflow-y-auto">
                <GalleryWall socket={socket} initialGallery={initialGallery} />
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
