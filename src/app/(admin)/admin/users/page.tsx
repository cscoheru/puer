"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { ROLES, ROLE_LABELS, isKnownRole } from "@/lib/permissions";
import { generateTempPassword, MIN_PASSWORD_LENGTH } from "@/lib/password-reset";

interface User {
  id: string;
  uid: number | null;
  username: string;
  email: string;
  avatar: string | null;
  level: number;
  karma: number;
  creditScore: number;
  noShowCount: number;
  followerCount: number;
  onlineStatus: string;
  banStatus: string;
  muteStatus: string;
  mutedUntil: string | null;
  warningCount: number;
  isSynthetic: boolean;
  role: string;
  createdAt: string;
  _count: { articles: number; comments: number };
}

/** 待处理的密码重置申请（用户在登录页点「忘记密码」留下的）。 */
interface ResetRequest {
  id: string;
  note: string | null;
  createdAt: string;
  user: { id: string; uid: number | null; username: string; email: string };
}

/** 正在重置密码的对象：直接重置某个用户，或处理一条申请。 */
interface ResetTarget {
  userId: string;
  username: string;
  uid: number | null;
  requestId?: string;
}

const LEVEL_COLORS = [
  "bg-stone-100 text-stone-600",
  "bg-green-100 text-green-700",
  "bg-blue-100 text-blue-700",
  "bg-purple-100 text-purple-700",
  "bg-amber-100 text-amber-700",
];

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [level, setLevel] = useState("");
  const [banStatus, setBanStatus] = useState("");
  const [synthetic, setSynthetic] = useState("");
  const [message, setMessage] = useState("");
  const [levelLabels, setLevelLabels] = useState<string[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ username: "", password: "", role: "user" as "user" | "admin" });
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createdUid, setCreatedUid] = useState<number | null>(null);
  // 密码重置
  const [resetRequests, setResetRequests] = useState<ResetRequest[]>([]);
  const [resetTarget, setResetTarget] = useState<ResetTarget | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const limit = 20;

  const fetchResetRequests = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/password-resets");
      if (!res.ok) return;
      const data = await res.json();
      setResetRequests(Array.isArray(data.requests) ? data.requests : []);
    } catch {
      setResetRequests([]);
    }
  }, []);

  useEffect(() => {
    // promise 链写法（与下面 level-config 那个一致）：setState 在回调里，
    // 不在 effect 体里同步调用。
    fetch("/api/admin/password-resets")
      .then((r) => (r.ok ? r.json() : { requests: [] }))
      .then((d) => setResetRequests(Array.isArray(d.requests) ? d.requests : []))
      .catch(() => setResetRequests([]));
  }, []);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });
    if (keyword) params.set("keyword", keyword);
    if (level) params.set("level", level);
    if (banStatus) params.set("banStatus", banStatus);
    if (synthetic) params.set("synthetic", synthetic);

    try {
      const res = await fetch(`/api/admin/users?${params}`);
      const data = await res.json();
      setUsers(data.users || []);
      setTotal(data.total || 0);
    } catch {
      setMessage("加载失败");
    } finally {
      setLoading(false);
    }
  }, [page, keyword, level, banStatus, synthetic]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    fetch("/api/level-config")
      .then((r) => r.json())
      .then((data) => {
        if (data.levels) setLevelLabels(data.levels.map((l: { name: string }) => l.name));
      })
      .catch(() => {});
  }, []);

  const handleSearch = () => {
    setPage(1);
    fetchUsers();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  const handleBan = async (id: string, status: string) => {
    const reason = status === "banned" ? prompt("请输入封禁原因:") : null;
    if (status === "banned" && !reason) return;

    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          status === "banned"
            ? { banStatus: "banned", banReason: reason }
            : { banStatus: "active" }
        ),
      });
      if (res.ok) {
        setMessage(status === "banned" ? "已封禁" : "已解封");
        fetchUsers();
      } else {
        setMessage("操作失败");
      }
    } catch {
      setMessage("操作失败");
    }
  };

  // 自动化标记切换（F0）：cron 任务只在 isSynthetic=true 的账号里活动。
  // 打标前要确认——误标真人会让 cron 冒用他发言。
  const handleSyntheticToggle = async (id: string, next: boolean) => {
    if (next && !confirm("确认标记为自动化账号？\n此后自动投票/回复只会使用该账号，其行为不再计入真人指标。")) return;
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isSynthetic: next }),
      });
      if (res.ok) {
        setMessage(next ? "已标记为自动化账号" : "已取消自动化标记");
        fetchUsers();
      } else {
        setMessage("操作失败");
      }
    } catch {
      setMessage("操作失败");
    }
  };

  // 角色变更（PRD §13.4）：权限在界面上可改。
  // 授予管理员是给一个人开后门，所以要确认；降级同理（不可撤销）。
  const handleRoleChange = async (id: string, role: string) => {
    const label = ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role;
    if (!confirm(`确认把该用户的角色改为「${label}」？\n角色决定他能在后台做什么。`)) return;
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setMessage(`已改为「${label}」`);
        fetchUsers();
      } else {
        setMessage(data.error || "改角色失败");
      }
    } catch {
      setMessage("改角色失败");
    }
  };

  /** 打开重置弹窗。requestId 有值 = 处理一条申请，否则 = 直接重置该用户。 */
  const openReset = (t: ResetTarget) => {
    setResetTarget(t);
    setResetPassword("");
  };

  const handleResetPassword = async () => {
    if (!resetTarget || resetPassword.length < 6) return;
    setResetBusy(true);
    try {
      const url = resetTarget.requestId
        ? `/api/admin/password-resets/${resetTarget.requestId}`
        : `/api/admin/users/${resetTarget.userId}/password`;
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: resetPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error || "重置失败");
        return;
      }
      setMessage(
        `已重置「${resetTarget.username}」的密码，请把新密码告知本人。`,
      );
      setResetTarget(null);
      setResetPassword("");
      fetchResetRequests();
    } catch {
      setMessage("重置失败");
    } finally {
      setResetBusy(false);
    }
  };

  const totalPages = Math.ceil(total / limit);

  const handleCreateUser = async () => {
    if (!createForm.username || !createForm.password) return;
    setCreateSubmitting(true);
    try {
      const res = await fetch("/api/admin/users/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createForm),
      });
      const data = await res.json();
      if (res.ok) {
        setCreatedUid(data.uid);
        setCreateForm({ username: "", password: "", role: "user" });
        fetchUsers();
        setTimeout(() => { setCreatedUid(null); setShowCreate(false); }, 3000);
      } else {
        setMessage(data.error || "创建失败");
      }
    } catch {
      setMessage("创建失败");
    } finally {
      setCreateSubmitting(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-serif font-bold text-stone-800">
            用户管理
          </h1>
          <p className="text-sm text-stone-500 mt-1">共 {total} 位用户</p>
        </div>
        <button
          onClick={() => { setShowCreate(true); setCreatedUid(null); }}
          className="px-4 py-2 text-sm bg-amber-800 text-white rounded-lg hover:bg-amber-900 transition"
        >
          + 创建用户
        </button>
      </div>

      {/* Create user modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowCreate(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-sm w-full mx-4 p-5" onClick={(e) => e.stopPropagation()}>
            {createdUid ? (
              <div className="text-center py-4">
                <p className="text-3xl font-bold font-mono text-amber-800 mb-2">#{createdUid}</p>
                <p className="text-sm text-stone-600">创建成功！请将此 UID 号告知茶友</p>
              </div>
            ) : (
              <>
                <h3 className="text-sm font-semibold text-stone-800 mb-3">创建新用户</h3>
                <div className="space-y-3">
                  <input
                    value={createForm.username}
                    onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
                    placeholder="用户名"
                    className="w-full px-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-amber-300"
                  />
                  <input
                    type="password"
                    value={createForm.password}
                    onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                    placeholder="密码（至少6位）"
                    className="w-full px-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-amber-300"
                  />
                  <select
                    value={createForm.role}
                    onChange={(e) => setCreateForm({ ...createForm, role: e.target.value as "user" | "admin" })}
                    className="w-full px-3 py-2 text-sm border border-stone-200 rounded-lg bg-white focus:outline-none"
                  >
                    <option value="user">普通用户</option>
                    <option value="admin">管理员</option>
                  </select>
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-sm text-stone-500 hover:text-stone-700">取消</button>
                    <button
                      onClick={handleCreateUser}
                      disabled={createSubmitting || !createForm.username || createForm.password.length < 6}
                      className="px-4 py-1.5 text-sm bg-amber-800 text-white rounded-lg hover:bg-amber-900 disabled:opacity-50"
                    >
                      {createSubmitting ? "创建中..." : "创建"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 重置密码弹窗 */}
      {resetTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => !resetBusy && setResetTarget(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-sm w-full mx-4 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-stone-800 mb-1">
              重置「{resetTarget.username}」的密码
            </h3>
            <p className="text-xs text-stone-500 mb-3">
              {resetTarget.uid != null && `UID #${resetTarget.uid} · `}
              新密码至少 6 位。站内没有邮件通道，请把新密码另行告知本人。
            </p>
            <div className="space-y-3">
              <input
                type="text"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                placeholder="新密码"
                autoComplete="off"
                className="w-full px-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-amber-300 font-mono"
              />
              <button
                onClick={() => setResetPassword(generateTempPassword())}
                className="px-3 py-1.5 text-xs border border-stone-200 rounded-lg hover:bg-stone-50 transition"
              >
                随机生成
              </button>
            </div>
            <div className="flex gap-2 justify-end mt-4">
              <button
                onClick={() => setResetTarget(null)}
                disabled={resetBusy}
                className="px-3 py-1.5 text-sm text-stone-500 hover:text-stone-700"
              >
                取消
              </button>
              <button
                onClick={handleResetPassword}
                disabled={resetBusy || resetPassword.length < MIN_PASSWORD_LENGTH}
                className="px-4 py-1.5 text-sm bg-amber-800 text-white rounded-lg hover:bg-amber-900 disabled:opacity-50"
              >
                {resetBusy ? "重置中..." : "确认重置"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white border border-stone-200 rounded-lg p-4 mb-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="搜索 UID、用户名或邮箱"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 min-w-[200px] px-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:border-amber-400"
        />
        <select
          value={level}
          onChange={(e) => { setLevel(e.target.value); setPage(1); }}
          className="px-3 py-2 text-sm border border-stone-200 rounded-lg bg-white focus:outline-none focus:border-amber-400"
        >
          <option value="">全部等级</option>
          {levelLabels.map((label, i) => (
            <option key={i} value={i}>{label} (Lv.{i})</option>
          ))}
        </select>
        <select
          value={banStatus}
          onChange={(e) => { setBanStatus(e.target.value); setPage(1); }}
          className="px-3 py-2 text-sm border border-stone-200 rounded-lg bg-white focus:outline-none focus:border-amber-400"
        >
          <option value="">全部状态</option>
          <option value="active">正常</option>
          <option value="banned">已封禁</option>
        </select>
        <select
          value={synthetic}
          onChange={(e) => { setSynthetic(e.target.value); setPage(1); }}
          className="px-3 py-2 text-sm border border-stone-200 rounded-lg bg-white focus:outline-none focus:border-amber-400"
        >
          <option value="">全部标记</option>
          <option value="1">自动化账号</option>
          <option value="0">真人</option>
        </select>
        <button
          onClick={handleSearch}
          className="px-4 py-2 text-sm bg-amber-800 text-white rounded-lg hover:bg-amber-900 transition"
        >
          搜索
        </button>
      </div>

      {message && (
        <p className="mb-4 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">
          {message}
        </p>
      )}

      {/* 密码重置申请：用户在登录页点「忘记密码」留下的 */}
      {resetRequests.length > 0 && (
        <div className="bg-white border border-amber-300 rounded-lg p-4 mb-4">
          <h2 className="text-sm font-semibold text-stone-800 mb-3">
            密码重置申请（{resetRequests.length}）
          </h2>
          <p className="text-xs text-stone-500 mb-3">
            站内没有邮件通道，用户提交申请后需要你重置密码并另行告知本人。
          </p>
          <div className="space-y-2">
            {resetRequests.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center gap-3 border border-stone-100 rounded-lg px-3 py-2"
              >
                <div className="flex-1 min-w-[200px]">
                  <p className="text-sm text-stone-800">
                    {r.user.username}
                    <span className="ml-2 text-xs text-stone-400">
                      #{r.user.uid ?? "-"} · {r.user.email}
                    </span>
                  </p>
                  {r.note && (
                    <p className="text-xs text-stone-500 mt-0.5">说明：{r.note}</p>
                  )}
                  <p className="text-[0.65rem] text-stone-400 mt-0.5">
                    申请于 {r.createdAt.slice(0, 16).replace("T", " ")}
                  </p>
                </div>
                <button
                  onClick={() =>
                    openReset({
                      userId: r.user.id,
                      username: r.user.username,
                      uid: r.user.uid,
                      requestId: r.id,
                    })
                  }
                  className="px-3 py-1.5 text-xs bg-amber-800 text-white rounded-lg hover:bg-amber-900 transition"
                >
                  重置密码
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-center text-stone-400 py-10">加载中...</p>
      ) : users.length === 0 ? (
        <p className="text-center text-stone-400 py-10">暂无用户</p>
      ) : (
        <>
          <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-stone-50 border-b border-stone-200">
                    <th className="text-center px-4 py-3 text-stone-500 font-medium">UID</th>
                    <th className="text-left px-4 py-3 text-stone-500 font-medium">用户</th>
                    <th className="text-left px-4 py-3 text-stone-500 font-medium">邮箱</th>
                    <th className="text-center px-4 py-3 text-stone-500 font-medium">等级</th>
                    <th className="text-center px-4 py-3 text-stone-500 font-medium">声望</th>
                    <th className="text-center px-4 py-3 text-stone-500 font-medium">信用</th>
                    <th className="text-center px-4 py-3 text-stone-500 font-medium">帖子</th>
                    <th className="text-center px-4 py-3 text-stone-500 font-medium">评论</th>
                    <th className="text-center px-4 py-3 text-stone-500 font-medium">状态</th>
                    <th className="text-center px-4 py-3 text-stone-500 font-medium">角色</th>
                    <th className="text-center px-4 py-3 text-stone-500 font-medium">标记</th>
                    <th className="text-center px-4 py-3 text-stone-500 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-b border-stone-100 hover:bg-stone-50 transition">
                      <td className="px-4 py-3 text-center font-mono text-stone-600">
                        {u.uid ?? "-"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {u.avatar ? (
                            <img src={u.avatar} alt="" className="w-8 h-8 rounded-full object-cover" />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-stone-200 flex items-center justify-center text-xs text-stone-500">
                              {u.username[0]}
                            </div>
                          )}
                          <Link
                            href={`/admin/users/${u.id}`}
                            className="text-stone-800 hover:text-amber-700 font-medium transition"
                          >
                            {u.username}
                          </Link>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-stone-500">{u.email}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${LEVEL_COLORS[u.level] || LEVEL_COLORS[0]}`}>
                          Lv.{u.level} {levelLabels[u.level]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center text-stone-600">{u.karma}</td>
                      <td className="px-4 py-3 text-center text-stone-600">{u.creditScore}</td>
                      <td className="px-4 py-3 text-center text-stone-600">{u._count.articles}</td>
                      <td className="px-4 py-3 text-center text-stone-600">{u._count.comments}</td>
                      <td className="px-4 py-3 text-center">
                        {u.banStatus === "banned" ? (
                          <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                            已封禁
                          </span>
                        ) : u.muteStatus === "muted" && u.mutedUntil && new Date(u.mutedUntil) > new Date() ? (
                          <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-700">
                            禁言中
                          </span>
                        ) : u.warningCount > 0 ? (
                          <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
                            {u.warningCount}次警告
                          </span>
                        ) : (
                          <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                            正常
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <select
                          value={isKnownRole(u.role) ? u.role : "user"}
                          onChange={(e) => handleRoleChange(u.id, e.target.value)}
                          className={
                            "text-xs px-1.5 py-1 rounded border focus:outline-none focus:border-amber-500 " +
                            (u.role === "admin"
                              ? "bg-amber-50 text-amber-800 border-amber-200"
                              : "bg-white text-stone-600 border-stone-200")
                          }
                          title="角色决定该用户能在后台做什么"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {u.isSynthetic ? (
                          <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-stone-200 text-stone-600">
                            自动化
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <Link
                            href={`/admin/users/${u.id}`}
                            className="px-2 py-1 text-xs text-amber-700 hover:bg-amber-50 rounded transition"
                          >
                            查看
                          </Link>
                          <button
                            onClick={() =>
                              openReset({
                                userId: u.id,
                                username: u.username,
                                uid: u.uid,
                              })
                            }
                            className="px-2 py-1 text-xs text-stone-500 hover:text-amber-700 hover:bg-amber-50 rounded transition"
                            title="重置该用户的密码"
                          >
                            重置密码
                          </button>
                          {u.isSynthetic ? (
                            <button
                              onClick={() => handleSyntheticToggle(u.id, false)}
                              className="px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 rounded transition"
                              title="取消自动化标记（该账号退出 cron 池）"
                            >
                              取消标记
                            </button>
                          ) : (
                            <button
                              onClick={() => handleSyntheticToggle(u.id, true)}
                              className="px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 rounded transition"
                              title="标记为自动化账号（进入 cron 池）"
                            >
                              标自动化
                            </button>
                          )}
                          {u.banStatus === "banned" ? (
                            <button
                              onClick={() => handleBan(u.id, "active")}
                              className="px-2 py-1 text-xs text-green-700 hover:bg-green-50 rounded transition"
                            >
                              解封
                            </button>
                          ) : (
                            <button
                              onClick={() => handleBan(u.id, "banned")}
                              className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded transition"
                            >
                              封禁
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
