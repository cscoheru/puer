"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import SessionCard from "./session-card";
import { SESSION_STATUS, type SessionStatus } from "@/lib/session-constants";

type SessionSummary = {
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
  createdAt: string;
};

interface Props {
  live: SessionSummary[];
  upcoming: SessionSummary[];
  ended: SessionSummary[];
  currentUserId?: string;
  userLevel: number;
}

type TabKey = "live" | "upcoming" | "ended" | "invited";

export default function SessionHallClient({
  live,
  upcoming,
  ended,
  currentUserId,
  userLevel,
}: Props) {
  const [tab, setTab] = useState<TabKey>("live");
  const [invited, setInvited] = useState<SessionSummary[]>([]);
  const [loadingInvited, setLoadingInvited] = useState(false);

  useEffect(() => {
    if (tab === "invited" && invited.length === 0 && !loadingInvited) {
      fetchInvited();
    }
  }, [tab]);

  const fetchInvited = async () => {
    setLoadingInvited(true);
    try {
      const res = await fetch("/api/sessions?invited=true");
      if (res.ok) {
        const data = await res.json();
        setInvited(data.sessions || []);
      }
    } catch {
      // silent
    } finally {
      setLoadingInvited(false);
    }
  };

  const tabs: Record<TabKey, SessionSummary[]> = {
    live,
    upcoming,
    ended,
    invited: invited,
  };

  const current = tabs[tab];

  const TABS: { key: TabKey; label: string }[] = [
    { key: "live", label: "进行中" },
    { key: "upcoming", label: "即将开始" },
    { key: "ended", label: "已结束" },
    ...(currentUserId ? [{ key: "invited" as TabKey, label: "我的邀请" }] : []),
  ];

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-stone-800">云喝茶</h1>
        <Link
          href="/sessions/new"
          className="inline-flex items-center gap-1 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition text-sm font-medium"
        >
          + 发起茶会
        </Link>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-amber-100 overflow-x-auto">
        {TABS.map((t) => {
          const count = tabs[t.key]?.length ?? 0;
          const isInvitedTab = t.key === "invited";

          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-shrink-0 px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
                tab === t.key
                  ? "text-amber-700 border-amber-600"
                  : "text-stone-400 border-transparent hover:text-stone-600"
              }`}
            >
              {t.label}
              {isInvitedTab && count > 0 ? (
                <span className="ml-1.5 text-xs bg-amber-500 text-white px-1.5 py-0.5 rounded-full">
                  {count}
                </span>
              ) : count > 0 ? (
                <span className="ml-1.5 text-xs text-stone-300">
                  ({count})
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Content */}
      {tab === "invited" && loadingInvited ? (
        <div className="text-center py-16 text-stone-400">
          <div className="w-8 h-8 border-2 border-amber-600 border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
      ) : current.length === 0 ? (
        <div className="text-center py-16 text-stone-400">
          <div className="text-5xl mb-4">🍵</div>
          <p className="text-lg">
            {tab === "invited" ? "暂无邀请" : "还没有茶席"}
          </p>
          <p className="text-sm mt-1">
            {tab === "invited" ? "等待茶友邀请你吧" : "来发起一场茶会吧"}
          </p>
          {tab !== "invited" && userLevel >= 2 && (
            <Link
              href="/sessions/new"
              className="inline-block mt-4 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition text-sm"
            >
              发起茶会
            </Link>
          )}
          {tab !== "invited" && userLevel < 2 && (
            <p className="text-xs text-stone-400 mt-2">Lv.2 以上可以发起茶会</p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {current.map((s) => (
            <SessionCard
              key={s.id}
              {...s}
            />
          ))}
        </div>
      )}
    </div>
  );
}
