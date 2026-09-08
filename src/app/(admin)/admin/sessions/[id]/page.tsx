"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";

interface Participant {
  id: string;
  enteredAt: string;
  leftAt: string | null;
  user: { id: string; username: string; avatar: string | null };
}

interface Invitation {
  id: string;
  status: string;
  invitee: { id: string; username: string; avatar: string | null };
}

interface Message {
  id: string;
  content: string;
  createdAt: string;
  user: { id: string; username: string };
}

interface SessionDetail {
  id: string;
  title: string;
  teaName: string;
  status: string;
  description: string | null;
  brewMethod: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  maxParticipants: number;
  host: { id: string; username: string; avatar: string | null; level: number };
  participants: Participant[];
  invitations: Invitation[];
  messages: Message[];
}

const STATUS_COLORS: Record<string, string> = {
  inviting: "bg-purple-100 text-purple-700",
  confirmed: "bg-blue-100 text-blue-700",
  live: "bg-green-100 text-green-700",
  ended: "bg-gray-100 text-gray-500",
  expired: "bg-red-100 text-red-500",
  cancelled: "bg-gray-100 text-gray-400",
};

const STATUS_LABELS: Record<string, string> = {
  inviting: "邀请中",
  confirmed: "已确认",
  live: "进行中",
  ended: "已结束",
  expired: "已过期",
  cancelled: "已取消",
};

const INVITATION_STATUS_LABELS: Record<string, string> = {
  pending: "待回复",
  accepted: "已接受",
  declined: "已拒绝",
  expired: "已过期",
};

const INVITATION_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  accepted: "bg-green-100 text-green-700",
  declined: "bg-red-100 text-red-600",
  expired: "bg-stone-100 text-stone-400",
};

export default function AdminSessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const fetchSession = async () => {
    try {
      const res = await fetch(`/api/admin/sessions/${id}`);
      const data = await res.json();
      if (data.error) {
        setMessage(data.error);
      } else {
        setSession(data);
      }
    } catch {
      setMessage("加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSession();
  }, [id]);

  const handleStatusChange = async (newStatus: string) => {
    const label = STATUS_LABELS[newStatus] || newStatus;
    if (!confirm(`确定将茶会状态改为「${label}」？`)) return;
    setMessage("更新中...");
    try {
      const res = await fetch(`/api/admin/sessions/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        setMessage("更新成功");
        fetchSession();
      } else {
        setMessage("更新失败");
      }
    } catch {
      setMessage("更新失败");
    }
  };

  const formatDuration = (start: string | null, end: string | null): string => {
    if (!start) return "-";
    const s = new Date(start).getTime();
    const e = end ? new Date(end).getTime() : Date.now();
    const mins = Math.round((e - s) / 60000);
    if (mins < 60) return `${mins} 分钟`;
    return `${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟`;
  };

  if (loading) {
    return <p className="text-center text-stone-400 py-20">加载中...</p>;
  }

  if (!session) {
    return <p className="text-center text-stone-400 py-20">{message || "茶会不存在"}</p>;
  }

  return (
    <div className="max-w-4xl mx-auto py-8">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/admin/sessions" className="hover:text-amber-700 transition">茶会管理</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">{session.title}</span>
      </nav>

      <h1 className="text-2xl font-serif font-bold text-stone-800 mb-6">茶会详情</h1>

      {message && (
        <p className="mb-4 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">{message}</p>
      )}

      {/* Session Info Card */}
      <div className="bg-white border border-stone-200 rounded-lg p-6 mb-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h2 className="text-lg font-bold text-stone-800">{session.title}</h2>
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[session.status] || "bg-stone-100 text-stone-500"}`}>
                {STATUS_LABELS[session.status] || session.status}
              </span>
            </div>
            <p className="text-sm text-stone-500">
              茶品: <span className="text-stone-700">{session.teaName}</span>
              {session.brewMethod && ` · 泡法: ${session.brewMethod}`}
            </p>
          </div>
          <div className="text-right text-xs text-stone-400">
            <div>发起人: <span className="text-stone-600">{session.host.username}</span></div>
            <div>Lv.{session.host.level}</div>
          </div>
        </div>

        {session.description && (
          <p className="text-sm text-stone-600 mb-4 p-3 bg-stone-50 rounded-lg">{session.description}</p>
        )}

        {/* Time Info */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-stone-100">
          <div>
            <div className="text-xs text-stone-400">计划时间</div>
            <div className="text-sm text-stone-700">
              {session.scheduledAt ? new Date(session.scheduledAt).toLocaleString("zh-CN") : "-"}
            </div>
          </div>
          <div>
            <div className="text-xs text-stone-400">开始时间</div>
            <div className="text-sm text-stone-700">
              {session.startedAt ? new Date(session.startedAt).toLocaleString("zh-CN") : "-"}
            </div>
          </div>
          <div>
            <div className="text-xs text-stone-400">结束时间</div>
            <div className="text-sm text-stone-700">
              {session.endedAt ? new Date(session.endedAt).toLocaleString("zh-CN") : "-"}
            </div>
          </div>
          <div>
            <div className="text-xs text-stone-400">持续时间</div>
            <div className="text-sm text-stone-700">{formatDuration(session.startedAt, session.endedAt)}</div>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 pt-4 mt-4 border-t border-stone-100">
          <div>
            <div className="text-xs text-stone-400">创建时间</div>
            <div className="text-sm text-stone-700">{new Date(session.createdAt).toLocaleString("zh-CN")}</div>
          </div>
          <div>
            <div className="text-xs text-stone-400">最大参与人数</div>
            <div className="text-sm text-stone-700">{session.maxParticipants || "-"}</div>
          </div>
          <div>
            <div className="text-xs text-stone-400">峰值参与</div>
            <div className="text-sm text-stone-700">{session.participants.length} 人</div>
          </div>
        </div>
      </div>

      {/* Participants */}
      <div className="bg-white border border-stone-200 rounded-lg p-6 mb-6">
        <h3 className="text-base font-bold text-stone-800 mb-4">
          参与者 ({session.participants.length})
        </h3>
        {session.participants.length === 0 ? (
          <p className="text-sm text-stone-400">暂无参与者</p>
        ) : (
          <div className="space-y-2">
            {session.participants.map((p) => (
              <div key={p.id} className="flex items-center gap-3 p-2 bg-stone-50 rounded-lg">
                {p.user.avatar ? (
                  <img src={p.user.avatar} alt="" className="w-7 h-7 rounded-full object-cover" />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-stone-200 flex items-center justify-center text-xs text-stone-500">
                    {p.user.username[0]}
                  </div>
                )}
                <span className="text-sm text-stone-700 font-medium">{p.user.username}</span>
                <span className="text-xs text-stone-400">
                  进入: {new Date(p.enteredAt).toLocaleString("zh-CN")}
                  {p.leftAt && ` · 离开: ${new Date(p.leftAt).toLocaleString("zh-CN")}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Invitations */}
      <div className="bg-white border border-stone-200 rounded-lg p-6 mb-6">
        <h3 className="text-base font-bold text-stone-800 mb-4">
          邀请 ({session.invitations.length})
        </h3>
        {session.invitations.length === 0 ? (
          <p className="text-sm text-stone-400">暂无邀请</p>
        ) : (
          <div className="space-y-2">
            {session.invitations.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between p-2 bg-stone-50 rounded-lg">
                <div className="flex items-center gap-3">
                  {inv.invitee.avatar ? (
                    <img src={inv.invitee.avatar} alt="" className="w-7 h-7 rounded-full object-cover" />
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-stone-200 flex items-center justify-center text-xs text-stone-500">
                      {inv.invitee.username[0]}
                    </div>
                  )}
                  <span className="text-sm text-stone-700 font-medium">{inv.invitee.username}</span>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${INVITATION_STATUS_COLORS[inv.status] || "bg-stone-100 text-stone-500"}`}>
                  {INVITATION_STATUS_LABELS[inv.status] || inv.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Messages */}
      <div className="bg-white border border-stone-200 rounded-lg p-6 mb-6">
        <h3 className="text-base font-bold text-stone-800 mb-4">
          最近消息 (最近 30 条)
        </h3>
        {session.messages.length === 0 ? (
          <p className="text-sm text-stone-400">暂无消息</p>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {session.messages.map((m) => (
              <div key={m.id} className="flex gap-2 p-2 hover:bg-stone-50 rounded">
                <span className="text-xs text-stone-400 w-32 shrink-0">
                  {new Date(m.createdAt).toLocaleString("zh-CN")}
                </span>
                <span className="text-xs text-amber-700 font-medium w-20 shrink-0 truncate">
                  {m.user.username}
                </span>
                <span className="text-sm text-stone-700 flex-1">{m.content}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Admin Actions */}
      <div className="bg-white border border-stone-200 rounded-lg p-6">
        <h3 className="text-base font-bold text-stone-800 mb-4">管理操作</h3>
        <div className="flex flex-wrap gap-2">
          {!["ended", "expired", "cancelled"].includes(session.status) && (
            <button
              onClick={() => handleStatusChange("cancelled")}
              className="px-4 py-2 text-sm bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition"
            >
              取消茶会
            </button>
          )}
          {session.status === "inviting" && (
            <button
              onClick={() => handleStatusChange("confirmed")}
              className="px-4 py-2 text-sm bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 transition"
            >
              确认茶会
            </button>
          )}
          {session.status === "confirmed" && (
            <button
              onClick={() => handleStatusChange("live")}
              className="px-4 py-2 text-sm bg-green-100 text-green-700 rounded-lg hover:bg-green-200 transition"
            >
              开始茶会
            </button>
          )}
          {session.status === "live" && (
            <button
              onClick={() => handleStatusChange("ended")}
              className="px-4 py-2 text-sm bg-stone-100 text-stone-600 rounded-lg hover:bg-stone-200 transition"
            >
              结束茶会
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
