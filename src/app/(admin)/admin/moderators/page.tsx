"use client";

import { useState, useEffect } from "react";

interface ModApp {
  id: string;
  status: string;
  role: string;
  teaAge: number | null;
  reason: string | null;
  appliedAt: string;
  approvedAt: string | null;
  board: { id: string; name: string; slug: string };
  user: { id: string; username: string; nickname: string | null; avatar: string | null; level: number };
}

const STATUS_MAP: Record<string, { label: string; className: string }> = {
  pending: { label: "待审批", className: "bg-amber-100 text-amber-800" },
  approved: { label: "已通过", className: "bg-green-100 text-green-700" },
  rejected: { label: "已拒绝", className: "bg-red-100 text-red-700" },
};

const ROLE_MAP: Record<string, { label: string; className: string }> = {
  moderator: { label: "版主", className: "bg-blue-100 text-blue-700" },
  deputy: { label: "副版主", className: "bg-purple-100 text-purple-700" },
};

export default function ModeratorsPage() {
  const [applications, setApplications] = useState<ModApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("pending");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [roleModal, setRoleModal] = useState<ModApp | null>(null);
  const [selectedRole, setSelectedRole] = useState("moderator");

  useEffect(() => { fetchApps(); }, []);

  const fetchApps = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/moderators");
      const data = await res.json();
      setApplications(data);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };

  const handleAction = async (id: string, action: "approve" | "reject", role?: string) => {
    setActionLoading(id);
    try {
      const body: Record<string, string> = { action };
      if (role) body.role = role;
      const res = await fetch(`/api/admin/moderators/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setMessage(action === "approve" ? "已批准" : "已拒绝");
        fetchApps();
      }
    } catch { setMessage("操作失败"); }
    finally { setActionLoading(null); }
  };

  const handleRemove = async (id: string) => {
    if (!confirm("确认移除该版主？")) return;
    setActionLoading(id);
    try {
      await fetch(`/api/admin/moderators/${id}`, { method: "DELETE" });
      setMessage("已移除");
      fetchApps();
    } catch { setMessage("操作失败"); }
    finally { setActionLoading(null); }
  };

  const handleRoleChange = async () => {
    if (!roleModal) return;
    setActionLoading(roleModal.id);
    try {
      await fetch(`/api/admin/moderators/${roleModal.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_role", role: selectedRole }),
      });
      setMessage(`已设为${ROLE_MAP[selectedRole]?.label || selectedRole}`);
      setRoleModal(null);
      fetchApps();
    } catch { setMessage("操作失败"); }
    finally { setActionLoading(null); }
  };

  const filtered = statusFilter
    ? applications.filter((a) => a.status === statusFilter)
    : applications;

  const pendingCount = applications.filter((a) => a.status === "pending").length;

  return (
    <div className="max-w-6xl mx-auto py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-serif font-bold text-stone-800">版主管理</h1>
        <p className="text-sm text-stone-500 mt-1">
          共 {applications.length} 条申请
          {pendingCount > 0 && <span className="text-amber-700 font-medium"> · {pendingCount} 条待审批</span>}
        </p>
      </div>

      {message && (
        <p className="mb-4 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">{message}</p>
      )}

      <div className="flex items-center gap-3 mb-4">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="text-sm border border-stone-200 rounded-lg px-3 py-1.5 bg-white text-stone-700 focus:outline-none">
          <option value="pending">待审批</option>
          <option value="approved">已通过</option>
          <option value="rejected">已拒绝</option>
          <option value="">全部</option>
        </select>
      </div>

      {loading ? (
        <p className="text-center text-stone-400 py-10">加载中...</p>
      ) : filtered.length === 0 ? (
        <p className="text-center text-stone-400 py-10">暂无{statusFilter === "pending" ? "待审批申请" : "记录"}</p>
      ) : (
        <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50">
                <th className="text-left px-4 py-3 text-stone-600 font-medium">申请人</th>
                <th className="text-left px-4 py-3 text-stone-600 font-medium">申请版块</th>
                <th className="text-left px-4 py-3 text-stone-600 font-medium">茶龄</th>
                <th className="text-left px-4 py-3 text-stone-600 font-medium">申请理由</th>
                <th className="text-left px-4 py-3 text-stone-600 font-medium">状态</th>
                <th className="text-left px-4 py-3 text-stone-600 font-medium">角色</th>
                <th className="text-left px-4 py-3 text-stone-600 font-medium">申请时间</th>
                <th className="text-right px-4 py-3 text-stone-600 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((app) => {
                const st = STATUS_MAP[app.status] || { label: app.status, className: "bg-gray-100 text-gray-600" };
                const rl = ROLE_MAP[app.role] || { label: app.role, className: "bg-gray-100 text-gray-600" };
                return (
                  <tr key={app.id} className="border-b border-stone-100 hover:bg-stone-50 transition">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {app.user.avatar ? (
                          <img src={app.user.avatar} alt="" className="w-7 h-7 rounded-full object-cover" />
                        ) : (
                          <div className="w-7 h-7 rounded-full bg-stone-200 flex items-center justify-center text-xs text-stone-500">
                            {(app.user.nickname || app.user.username)[0]}
                          </div>
                        )}
                        <div>
                          <p className="text-stone-800 font-medium">{app.user.nickname || app.user.username}</p>
                          <p className="text-xs text-stone-400">Lv.{app.user.level}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-stone-700">{app.board.name}</span>
                    </td>
                    <td className="px-4 py-3 text-stone-600">
                      {app.teaAge ? `${app.teaAge} 年` : <span className="text-stone-400">-</span>}
                    </td>
                    <td className="px-4 py-3 text-stone-600 max-w-[200px] truncate" title={app.reason || ""}>
                      {app.reason || <span className="text-stone-400">-</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs ${st.className}`}>{st.label}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs ${rl.className}`}>{rl.label}</span>
                    </td>
                    <td className="px-4 py-3 text-stone-400 text-xs">
                      {new Date(app.appliedAt).toLocaleDateString("zh-CN")}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {app.status === "pending" ? (
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => handleAction(app.id, "reject")} disabled={actionLoading === app.id}
                            className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded transition disabled:opacity-50">
                            拒绝
                          </button>
                          <button onClick={() => { setRoleModal(app); setSelectedRole("moderator"); }}
                            className="px-2 py-1 text-xs text-green-700 hover:bg-green-50 rounded transition">
                            批准
                          </button>
                        </div>
                      ) : app.status === "approved" ? (
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => { setRoleModal(app); setSelectedRole(app.role); }}
                            className="px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 rounded transition">
                            改角色
                          </button>
                          <button onClick={() => handleRemove(app.id)} disabled={actionLoading === app.id}
                            className="px-2 py-1 text-xs text-red-500 hover:bg-red-50 rounded transition disabled:opacity-50">
                            移除
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-stone-400">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Approve / Role change modal */}
      {roleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setRoleModal(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-sm w-full mx-4 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-stone-800 mb-3">
              {roleModal.status === "pending" ? "批准版主申请" : "修改角色"}
            </h3>

            <div className="p-3 bg-stone-50 rounded-lg mb-4 text-sm">
              <p className="text-stone-700">
                <strong>{roleModal.user.nickname || roleModal.user.username}</strong> → <strong>{roleModal.board.name}</strong>
              </p>
              {roleModal.reason && <p className="text-stone-500 text-xs mt-1">理由：{roleModal.reason}</p>}
              {roleModal.teaAge && <p className="text-stone-500 text-xs mt-0.5">茶龄：{roleModal.teaAge} 年</p>}
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium text-stone-700 mb-2">选择角色</label>
              <div className="flex gap-2">
                {(["moderator", "deputy"] as const).map((r) => (
                  <button key={r} onClick={() => setSelectedRole(r)}
                    className={`flex-1 px-3 py-2 text-sm rounded-lg border transition ${
                      selectedRole === r
                        ? r === "moderator"
                          ? "bg-blue-50 border-blue-300 text-blue-700 font-medium"
                          : "bg-purple-50 border-purple-300 text-purple-700 font-medium"
                        : "border-stone-200 text-stone-600 hover:bg-stone-50"
                    }`}>
                    {ROLE_MAP[r].label}
                    <p className="text-[10px] mt-0.5 opacity-70">
                      {r === "moderator" ? "可置顶/精华/删帖" : "可置顶/精华，删帖需审批"}
                    </p>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-2 justify-end">
              <button onClick={() => setRoleModal(null)} className="px-3 py-1.5 text-sm text-stone-500 hover:text-stone-700">取消</button>
              <button onClick={roleModal.status === "pending" ? () => { handleAction(roleModal.id, "approve", selectedRole); setRoleModal(null); } : handleRoleChange}
                disabled={actionLoading !== null}
                className="px-4 py-1.5 text-sm bg-amber-800 text-white rounded-lg hover:bg-amber-900 disabled:opacity-50">
                {actionLoading ? "处理中..." : "确认"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
