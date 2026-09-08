"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";

interface UserDetail {
  id: string;
  username: string;
  email: string;
  avatar: string | null;
  bio: string | null;
  level: number;
  karma: number;
  creditScore: number;
  noShowCount: number;
  followerCount: number;
  followingCount: number;
  onlineStatus: string;
  banStatus: string;
  bannedAt: string | null;
  banReason: string | null;
  role: string;
  createdAt: string;
  registrationIp: string | null;
  registrationRegion: string | null;
  _count: { articles: number; comments: number; teaSessions: number; actions: number };
}

const LEVEL_COLORS = [
  "bg-stone-100 text-stone-600",
  "bg-green-100 text-green-700",
  "bg-blue-100 text-blue-700",
  "bg-purple-100 text-purple-700",
  "bg-amber-100 text-amber-700",
];

export default function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [user, setUser] = useState<UserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [levelInput, setLevelInput] = useState(0);
  const [karmaInput, setKarmaInput] = useState(0);
  const [creditInput, setCreditInput] = useState(0);
  const [banReasonInput, setBanReasonInput] = useState("");
  const [levelLabels, setLevelLabels] = useState<string[]>([]);

  const fetchUser = async () => {
    try {
      const res = await fetch(`/api/admin/users/${id}`);
      const data = await res.json();
      if (data.error) {
        setMessage(data.error);
      } else {
        setUser(data);
        setLevelInput(data.level);
        setKarmaInput(data.karma);
        setCreditInput(data.creditScore);
      }
    } catch {
      setMessage("加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUser();
  }, [id]);

  useEffect(() => {
    fetch("/api/level-config")
      .then((r) => r.json())
      .then((data) => {
        if (data.levels) setLevelLabels(data.levels.map((l: { name: string }) => l.name));
      })
      .catch(() => {});
  }, []);

  const handleUpdate = async (body: Record<string, unknown>) => {
    setMessage("更新中...");
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setMessage("更新成功");
        fetchUser();
      } else {
        const err = await res.json();
        setMessage(err.error || "更新失败");
      }
    } catch {
      setMessage("更新失败");
    }
  };

  if (loading) {
    return <p className="text-center text-stone-400 py-20">加载中...</p>;
  }

  if (!user) {
    return <p className="text-center text-stone-400 py-20">{message || "用户不存在"}</p>;
  }

  return (
    <div className="max-w-4xl mx-auto py-8">
      <nav className="text-xs md:text-sm text-stone-400 mb-4">
        <Link href="/admin/users" className="hover:text-amber-700 transition">用户管理</Link>
        <span className="mx-2">/</span>
        <span className="text-stone-600">{user.username}</span>
      </nav>

      <h1 className="text-2xl font-serif font-bold text-stone-800 mb-6">用户详情</h1>

      {message && (
        <p className="mb-4 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">{message}</p>
      )}

      {/* Profile Card */}
      <div className="bg-white border border-stone-200 rounded-lg p-6 mb-6">
        <div className="flex items-start gap-5">
          {user.avatar ? (
            <img src={user.avatar} alt="" className="w-16 h-16 rounded-full object-cover" />
          ) : (
            <div className="w-16 h-16 rounded-full bg-stone-200 flex items-center justify-center text-xl text-stone-500">
              {user.username[0]}
            </div>
          )}
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <h2 className="text-lg font-bold text-stone-800">{user.username}</h2>
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${LEVEL_COLORS[user.level]}`}>
                Lv.{user.level} {levelLabels[user.level]}
              </span>
              {user.banStatus === "banned" && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                  已封禁
                </span>
              )}
              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-stone-100 text-stone-500">
                {user.role}
              </span>
            </div>
            <p className="text-sm text-stone-500 mb-1">{user.email}</p>
            {user.bio && <p className="text-sm text-stone-600 mb-2">{user.bio}</p>}
            <div className="flex flex-wrap gap-4 text-xs text-stone-500">
              <span>注册于 {new Date(user.createdAt).toLocaleString("zh-CN")}{user.registrationIp && <> · IP: {user.registrationIp}</>}{user.registrationRegion && <> · 📍 {user.registrationRegion}</>}</span>
              <span>{user.followerCount} 关注者</span>
              <span>{user.followingCount} 关注中</span>
              <span>{user._count.articles} 篇帖子</span>
              <span>{user._count.comments} 条评论</span>
              <span>{user._count.teaSessions} 场茶会</span>
              <span>缺席 {user.noShowCount} 次</span>
            </div>
            {user.banStatus === "banned" && (
              <div className="mt-2 text-xs text-red-600">
                封禁于 {user.bannedAt ? new Date(user.bannedAt).toLocaleString("zh-CN") : "-"}
                {user.banReason && ` · 原因: ${user.banReason}`}
              </div>
            )}
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4 mt-6 pt-4 border-t border-stone-100">
          <div className="text-center">
            <div className="text-lg font-bold text-stone-800">{user.karma}</div>
            <div className="text-xs text-stone-500">声望</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold text-stone-800">{user.creditScore}</div>
            <div className="text-xs text-stone-500">信用分</div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold text-stone-800">{user._count.actions}</div>
            <div className="text-xs text-stone-500">管理记录</div>
          </div>
        </div>
      </div>

      {/* Admin Actions */}
      <div className="bg-white border border-stone-200 rounded-lg p-6">
        <h3 className="text-base font-bold text-stone-800 mb-4">管理操作</h3>
        <div className="space-y-5">
          {/* Level */}
          <div className="flex items-center gap-3">
            <label className="text-sm text-stone-600 w-20 shrink-0">等级调整</label>
            <select
              value={levelInput}
              onChange={(e) => setLevelInput(Number(e.target.value))}
              className="px-3 py-2 text-sm border border-stone-200 rounded-lg bg-white focus:outline-none focus:border-amber-400"
            >
              {levelLabels.map((label, i) => (
                <option key={i} value={i}>Lv.{i} {label}</option>
              ))}
            </select>
            <button
              onClick={() => handleUpdate({ level: levelInput })}
              disabled={levelInput === user.level}
              className="px-4 py-2 text-sm bg-amber-800 text-white rounded-lg hover:bg-amber-900 disabled:opacity-30 transition"
            >
              应用
            </button>
          </div>

          {/* Karma */}
          <div className="flex items-center gap-3">
            <label className="text-sm text-stone-600 w-20 shrink-0">声望调整</label>
            <input
              type="number"
              value={karmaInput}
              onChange={(e) => setKarmaInput(Number(e.target.value))}
              className="w-32 px-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:border-amber-400"
            />
            <button
              onClick={() => handleUpdate({ karma: karmaInput })}
              disabled={karmaInput === user.karma}
              className="px-4 py-2 text-sm bg-amber-800 text-white rounded-lg hover:bg-amber-900 disabled:opacity-30 transition"
            >
              应用
            </button>
            <span className="text-xs text-stone-400">当前: {user.karma}</span>
          </div>

          {/* Credit */}
          <div className="flex items-center gap-3">
            <label className="text-sm text-stone-600 w-20 shrink-0">信用调整</label>
            <input
              type="number"
              value={creditInput}
              onChange={(e) => setCreditInput(Number(e.target.value))}
              className="w-32 px-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:border-amber-400"
            />
            <button
              onClick={() => handleUpdate({ creditScore: creditInput })}
              disabled={creditInput === user.creditScore}
              className="px-4 py-2 text-sm bg-amber-800 text-white rounded-lg hover:bg-amber-900 disabled:opacity-30 transition"
            >
              应用
            </button>
            <span className="text-xs text-stone-400">当前: {user.creditScore}</span>
          </div>

          {/* Ban / Unban */}
          <div className="pt-3 border-t border-stone-100">
            {user.banStatus === "banned" ? (
              <div className="flex items-center gap-3">
                <label className="text-sm text-stone-600 w-20 shrink-0">解封用户</label>
                <button
                  onClick={() => {
                    if (confirm("确定解封该用户？")) {
                      handleUpdate({ banStatus: "active" });
                    }
                  }}
                  className="px-4 py-2 text-sm bg-green-100 text-green-700 rounded-lg hover:bg-green-200 transition"
                >
                  解除封禁
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <label className="text-sm text-stone-600 w-20 shrink-0">封禁用户</label>
                <input
                  type="text"
                  placeholder="封禁原因"
                  value={banReasonInput}
                  onChange={(e) => setBanReasonInput(e.target.value)}
                  className="flex-1 max-w-xs px-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:border-red-400"
                />
                <button
                  onClick={() => {
                    if (!banReasonInput.trim()) {
                      setMessage("请填写封禁原因");
                      return;
                    }
                    if (confirm("确定封禁该用户？")) {
                      handleUpdate({ banStatus: "banned", banReason: banReasonInput });
                      setBanReasonInput("");
                    }
                  }}
                  className="px-4 py-2 text-sm bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition"
                >
                  封禁
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
