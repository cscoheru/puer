"use client";

import { useState, useEffect } from "react";
import OnlineStatusIndicator from "../online-status-indicator";

interface InvitationUser {
  id: string;
  username: string;
  avatar: string | null;
  level: number;
  onlineStatus: string;
}

interface Invitation {
  id: string;
  status: string;
  inviter: InvitationUser;
  invitee: InvitationUser;
  createdAt: string;
  respondedAt: string | null;
}

interface Props {
  sessionId: string;
  currentUserId?: string;
  hostId: string;
}

export default function InvitationList({ sessionId, currentUserId, hostId }: Props) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [responding, setResponding] = useState<string | null>(null);

  const fetchInvitations = async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/invitations`);
      if (res.ok) {
        const data = await res.json();
        setInvitations(data.invitations || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchInvitations();
  }, [sessionId]);

  const respond = async (inviteId: string, status: "accepted" | "declined") => {
    setResponding(inviteId);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/invitations/${inviteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.ok) fetchInvitations();
    } catch {
      // silent
    } finally {
      setResponding(null);
    }
  };

  if (loading) {
    return <div className="text-sm text-stone-400 py-4 text-center">加载中...</div>;
  }

  if (invitations.length === 0) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium text-stone-600">邀请列表</h4>
      {invitations.map((inv) => {
        const isInvitee = currentUserId === inv.invitee.id;
        const isPending = inv.status === "pending";
        const user = isInvitee ? inv.inviter : inv.invitee;
        const isResponding = responding === inv.id;

        return (
          <div key={inv.id} className="flex items-center gap-2 px-3 py-2 bg-stone-50 rounded-lg text-sm">
            <img
              src={user.avatar || "/default-avatar.svg"}
              alt=""
              className="w-6 h-6 rounded-full object-cover"
            />
            <span className="flex-1 min-w-0">
              <span className="font-medium text-stone-700">{user.username}</span>
              <span className="text-stone-400 ml-1">
                {isInvitee ? "邀请你" : `被邀请`}
              </span>
            </span>
            <OnlineStatusIndicator status={user.onlineStatus} size="sm" />

            {isPending && isInvitee ? (
              <div className="flex gap-1 flex-shrink-0">
                <button
                  onClick={() => respond(inv.id, "accepted")}
                  disabled={isResponding}
                  className="px-2 py-0.5 bg-amber-600 text-white rounded text-xs hover:bg-amber-700 disabled:opacity-50"
                >
                  接受
                </button>
                <button
                  onClick={() => respond(inv.id, "declined")}
                  disabled={isResponding}
                  className="px-2 py-0.5 text-stone-500 border border-stone-200 rounded text-xs hover:bg-stone-100 disabled:opacity-50"
                >
                  拒绝
                </button>
              </div>
            ) : (
              <span
                className={`text-xs flex-shrink-0 ${
                  inv.status === "accepted"
                    ? "text-green-600"
                    : inv.status === "declined"
                    ? "text-red-500"
                    : "text-amber-600"
                }`}
              >
                {inv.status === "accepted"
                  ? "已接受"
                  : inv.status === "declined"
                  ? "已拒绝"
                  : "待回应"}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
