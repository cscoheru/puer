"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

interface Session {
  id: string;
  title: string;
  teaName: string;
  status: string;
  scheduledAt: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  host: { id: string; username: string; avatar: string | null };
  _count: { messages: number; participants: number; invitations: number };
}

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "inviting", label: "邀请中" },
  { value: "confirmed", label: "已确认" },
  { value: "live", label: "进行中" },
  { value: "ended", label: "已结束" },
  { value: "expired", label: "已过期" },
  { value: "cancelled", label: "已取消" },
];

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

export default function AdminSessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [message, setMessage] = useState("");
  const limit = 20;

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });
    if (status) params.set("status", status);

    try {
      const res = await fetch(`/api/admin/sessions?${params}`);
      const data = await res.json();
      setSessions(data.sessions || []);
      setTotal(data.total || 0);
    } catch {
      setMessage("加载失败");
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const handleCancel = async (id: string) => {
    if (!confirm("确定取消该茶会？此操作不可撤销。")) return;
    setMessage("取消中...");
    try {
      const res = await fetch(`/api/admin/sessions/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
      });
      if (res.ok) {
        setMessage("已取消");
        fetchSessions();
      } else {
        setMessage("取消失败");
      }
    } catch {
      setMessage("取消失败");
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="max-w-6xl mx-auto py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-serif font-bold text-stone-800">
          茶会管理
        </h1>
        <p className="text-sm text-stone-500 mt-1">共 {total} 场茶会</p>
      </div>

      {/* Filter */}
      <div className="bg-white border border-stone-200 rounded-lg p-4 mb-4 flex items-center gap-3">
        <label className="text-sm text-stone-600">状态筛选:</label>
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          className="px-3 py-2 text-sm border border-stone-200 rounded-lg bg-white focus:outline-none focus:border-amber-400"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {message && (
        <p className="mb-4 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">{message}</p>
      )}

      {loading ? (
        <p className="text-center text-stone-400 py-10">加载中...</p>
      ) : sessions.length === 0 ? (
        <p className="text-center text-stone-400 py-10">暂无茶会</p>
      ) : (
        <>
          <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-stone-50 border-b border-stone-200">
                    <th className="text-left px-4 py-3 text-stone-500 font-medium">茶会</th>
                    <th className="text-left px-4 py-3 text-stone-500 font-medium">茶品</th>
                    <th className="text-left px-4 py-3 text-stone-500 font-medium">发起人</th>
                    <th className="text-center px-4 py-3 text-stone-500 font-medium">状态</th>
                    <th className="text-center px-4 py-3 text-stone-500 font-medium">参与</th>
                    <th className="text-center px-4 py-3 text-stone-500 font-medium">消息</th>
                    <th className="text-left px-4 py-3 text-stone-500 font-medium">计划时间</th>
                    <th className="text-left px-4 py-3 text-stone-500 font-medium">创建时间</th>
                    <th className="text-center px-4 py-3 text-stone-500 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id} className="border-b border-stone-100 hover:bg-stone-50 transition">
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/sessions/${s.id}`}
                          className="text-stone-800 hover:text-amber-700 font-medium transition"
                        >
                          {s.title}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-stone-600">{s.teaName}</td>
                      <td className="px-4 py-3 text-stone-600">{s.host.username}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[s.status] || "bg-stone-100 text-stone-500"}`}>
                          {STATUS_LABELS[s.status] || s.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center text-stone-600">{s._count.participants}</td>
                      <td className="px-4 py-3 text-center text-stone-600">{s._count.messages}</td>
                      <td className="px-4 py-3 text-stone-500 text-xs">
                        {s.scheduledAt ? new Date(s.scheduledAt).toLocaleString("zh-CN") : "-"}
                      </td>
                      <td className="px-4 py-3 text-stone-500 text-xs">
                        {new Date(s.createdAt).toLocaleString("zh-CN")}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <Link
                            href={`/admin/sessions/${s.id}`}
                            className="px-2 py-1 text-xs text-amber-700 hover:bg-amber-50 rounded transition"
                          >
                            查看
                          </Link>
                          {!["ended", "expired", "cancelled"].includes(s.status) && (
                            <button
                              onClick={() => handleCancel(s.id)}
                              className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded transition"
                            >
                              取消
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-center gap-2 mt-6">
              <button
                onClick={() => setPage(page - 1)}
                disabled={page === 1}
                className="px-3 py-1.5 text-sm border border-stone-200 rounded-lg hover:bg-stone-50 disabled:opacity-30 transition"
              >
                上一页
              </button>
              <span className="px-3 py-1.5 text-sm text-stone-500">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage(page + 1)}
                disabled={page >= totalPages}
                className="px-3 py-1.5 text-sm border border-stone-200 rounded-lg hover:bg-stone-50 disabled:opacity-30 transition"
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
