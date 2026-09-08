"use client";

import { useState, useEffect } from "react";

interface Report {
  id: string;
  reporterId: string;
  reporterName: string;
  targetType: string;
  targetId: string;
  reason: string;
  status: string;
  penalty?: string | null;
  penaltyDuration?: number | null;
  adminNote?: string | null;
  handlerName?: string;
  createdAt: string;
}

const STATUS_MAP: Record<string, { label: string; className: string }> = {
  pending: { label: "待处理", className: "bg-amber-100 text-amber-800" },
  dismissed: { label: "已驳回", className: "bg-gray-100 text-gray-600" },
  actioned: { label: "已处理", className: "bg-green-100 text-green-700" },
};

const PENALTY_MAP: Record<string, { label: string; className: string }> = {
  warning: { label: "警告", className: "bg-yellow-100 text-yellow-700" },
  mute: { label: "禁言", className: "bg-orange-100 text-orange-700" },
  ban: { label: "封禁", className: "bg-red-100 text-red-700" },
};

const TARGET_TYPE_MAP: Record<string, string> = {
  article: "文章",
  comment: "评论",
  user: "用户",
  session: "茶会",
};

export default function ReportsPage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("pending");
  const [typeFilter, setTypeFilter] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [handleModal, setHandleModal] = useState<Report | null>(null);
  const [handleAction, setHandleAction] = useState<"warning" | "mute" | "ban">("warning");
  const [muteDays, setMuteDays] = useState(7);
  const [adminNote, setAdminNote] = useState("");
  const [message, setMessage] = useState("");
  const limit = 20;

  useEffect(() => {
    fetchReports();
  }, [page, statusFilter, typeFilter]);

  const fetchReports = async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (statusFilter) params.set("status", statusFilter);
    if (typeFilter) params.set("targetType", typeFilter);

    try {
      const res = await fetch(`/api/admin/reports?${params}`);
      const data = await res.json();
      setReports(data.reports || []);
      setTotal(data.total || 0);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };

  const handleDismiss = async (id: string) => {
    setActionLoading(id);
    try {
      await fetch(`/api/admin/reports/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss", adminNote: "经查实不属实" }),
      });
      setMessage("已驳回并通知举报人");
      fetchReports();
    } catch { setMessage("操作失败"); }
    finally { setActionLoading(null); }
  };

  const handlePenalty = async () => {
    if (!handleModal) return;
    setActionLoading(handleModal.id);
    try {
      const body: Record<string, unknown> = {
        action: handleAction,
        adminNote: adminNote || undefined,
        targetUserId: handleModal.targetType === "user" ? handleModal.targetId : undefined,
      };
      if (handleAction === "mute") body.muteDays = muteDays;

      const res = await fetch(`/api/admin/reports/${handleModal.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage(`处理成功：${PENALTY_MAP[handleAction]?.label || handleAction}`);
        setHandleModal(null);
        setAdminNote("");
        fetchReports();
      } else {
        setMessage(data.error || "处理失败");
      }
    } catch { setMessage("操作失败"); }
    finally { setActionLoading(null); }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="max-w-6xl mx-auto py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-serif font-bold text-stone-800">举报管理</h1>
        <p className="text-sm text-stone-500 mt-1">共 {total} 条举报</p>
      </div>

      {message && (
        <p className="mb-4 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">{message}</p>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="text-sm border border-stone-200 rounded-lg px-3 py-1.5 bg-white text-stone-700 focus:outline-none">
          <option value="">全部状态</option>
          <option value="pending">待处理</option>
          <option value="dismissed">已驳回</option>
          <option value="actioned">已处理</option>
        </select>
        <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
          className="text-sm border border-stone-200 rounded-lg px-3 py-1.5 bg-white text-stone-700 focus:outline-none">
          <option value="">全部类型</option>
          <option value="article">文章</option>
          <option value="comment">评论</option>
          <option value="user">用户</option>
          <option value="session">茶会</option>
        </select>
      </div>

      {loading ? (
        <p className="text-center text-stone-400 py-10">加载中...</p>
      ) : reports.length === 0 ? (
        <p className="text-center text-stone-400 py-10">暂无举报</p>
      ) : (
        <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50">
                <th className="text-left px-4 py-3 text-stone-600 font-medium">举报人</th>
                <th className="text-left px-4 py-3 text-stone-600 font-medium">类型</th>
                <th className="text-left px-4 py-3 text-stone-600 font-medium">原因</th>
                <th className="text-left px-4 py-3 text-stone-600 font-medium">状态</th>
                <th className="text-left px-4 py-3 text-stone-600 font-medium">处罚</th>
                <th className="text-left px-4 py-3 text-stone-600 font-medium">时间</th>
                <th className="text-right px-4 py-3 text-stone-600 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => {
                const st = STATUS_MAP[r.status] || { label: r.status, className: "bg-gray-100 text-gray-600" };
                const pn = r.penalty ? PENALTY_MAP[r.penalty] : null;
                return (
                  <tr key={r.id} className="border-b border-stone-100 hover:bg-stone-50 transition">
                    <td className="px-4 py-3 text-stone-800">{r.reporterName}</td>
                    <td className="px-4 py-3">
                      <span className="inline-block px-2 py-0.5 rounded text-xs bg-stone-100 text-stone-600">
                        {TARGET_TYPE_MAP[r.targetType] || r.targetType}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-stone-600 max-w-[200px] truncate" title={r.reason}>
                      {r.reason}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs ${st.className}`}>{st.label}</span>
                    </td>
                    <td className="px-4 py-3">
                      {pn ? (
                        <span className={`inline-block px-2 py-0.5 rounded text-xs ${pn.className}`}>
                          {pn.label}{r.penaltyDuration ? ` ${r.penaltyDuration}天` : ""}
                        </span>
                      ) : <span className="text-xs text-stone-400">-</span>}
                    </td>
                    <td className="px-4 py-3 text-stone-400 text-xs">
                      {new Date(r.createdAt).toLocaleDateString("zh-CN")}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.status === "pending" ? (
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => handleDismiss(r.id)} disabled={actionLoading === r.id}
                            className="px-2 py-1 text-xs text-stone-500 hover:text-stone-700 hover:bg-stone-100 rounded transition disabled:opacity-50">
                            驳回
                          </button>
                          <button onClick={() => { setHandleModal(r); setHandleAction("warning"); setAdminNote(""); }}
                            className="px-2 py-1 text-xs text-amber-700 hover:bg-amber-50 rounded transition">
                            处理
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-stone-400">{r.handlerName || "已处理"}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-6">
          <button onClick={() => setPage(page - 1)} disabled={page === 1}
            className="px-3 py-1.5 text-sm border border-stone-200 rounded-lg hover:bg-stone-50 disabled:opacity-30">
            上一页
          </button>
          <span className="px-3 py-1.5 text-sm text-stone-500">{page} / {totalPages}</span>
          <button onClick={() => setPage(page + 1)} disabled={page >= totalPages}
            className="px-3 py-1.5 text-sm border border-stone-200 rounded-lg hover:bg-stone-50 disabled:opacity-30">
            下一页
          </button>
        </div>
      )}

      {/* Handle Modal */}
      {handleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setHandleModal(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-stone-800 mb-3">处理举报</h3>

            {/* Report summary */}
            <div className="p-3 bg-stone-50 rounded-lg mb-4 text-sm">
              <p className="text-stone-600"><strong>举报原因：</strong>{handleModal.reason}</p>
              <p className="text-stone-400 text-xs mt-1">
                {TARGET_TYPE_MAP[handleModal.targetType]} · {handleModal.reporterName} 举报
              </p>
            </div>

            {/* Penalty selection */}
            <div className="space-y-2 mb-4">
              <label className="block text-sm font-medium text-stone-700">选择处罚</label>
              {([
                { value: "warning" as const, label: "警告", desc: "通知违规，不限制操作。累计警告可升级为禁言。", color: "text-yellow-700 bg-yellow-50 border-yellow-200" },
                { value: "mute" as const, label: "禁言", desc: "不可发帖/回复，可浏览。7-30天。", color: "text-orange-700 bg-orange-50 border-orange-200" },
                { value: "ban" as const, label: "封禁", desc: "永久封禁账号，不可登录。用于严重违规。", color: "text-red-700 bg-red-50 border-red-200" },
              ]).map((opt) => (
                <label key={opt.value}
                  className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer transition ${handleAction === opt.value ? opt.color : "border-stone-200 hover:border-stone-300"}`}>
                  <input type="radio" name="penalty" value={opt.value} checked={handleAction === opt.value}
                    onChange={() => setHandleAction(opt.value)} className="mt-0.5 accent-amber-600" />
                  <div>
                    <span className="text-sm font-medium">{opt.label}</span>
                    <p className="text-xs text-stone-500 mt-0.5">{opt.desc}</p>
                  </div>
                </label>
              ))}
            </div>

            {/* Mute days */}
            {handleAction === "mute" && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-stone-700 mb-1">禁言天数</label>
                <div className="flex gap-2">
                  {[7, 14, 30].map((d) => (
                    <button key={d} onClick={() => setMuteDays(d)}
                      className={`px-3 py-1.5 text-sm rounded-lg border transition ${muteDays === d ? "bg-orange-100 border-orange-300 text-orange-700" : "border-stone-200 text-stone-600 hover:bg-stone-50"}`}>
                      {d} 天
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Admin note */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-stone-700 mb-1">管理员备注（可选）</label>
              <textarea value={adminNote} onChange={(e) => setAdminNote(e.target.value)}
                placeholder="记录处理原因..."
                className="w-full text-sm border border-stone-200 rounded-lg px-3 py-2 resize-none h-16 focus:outline-none focus:ring-1 focus:ring-amber-300" />
            </div>

            <div className="flex gap-2 justify-end">
              <button onClick={() => setHandleModal(null)} className="px-3 py-1.5 text-sm text-stone-500 hover:text-stone-700">取消</button>
              <button onClick={handlePenalty} disabled={actionLoading !== null}
                className="px-4 py-1.5 text-sm bg-amber-800 text-white rounded-lg hover:bg-amber-900 disabled:opacity-50">
                {actionLoading ? "处理中..." : "确认处理"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
