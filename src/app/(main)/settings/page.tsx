"use client";

import { useState, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";

interface UserProfile {
  id: string;
  uid: number | null;
  username: string;
  nickname?: string | null;
  avatar: string | null;
  bio: string | null;
  email: string;
  level: number;
}

export default function SettingsPage() {
  const { data: session, status, update } = useSession();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status !== "authenticated") return;
    fetch("/api/user/profile")
      .then((res) => res.json())
      .then((data) => setProfile(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [status]);

  if (status === "loading" || (status === "authenticated" && loading)) {
    return <div className="text-center py-12 text-stone-400">加载中...</div>;
  }

  if (status === "unauthenticated") {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 text-center">
        <p className="text-stone-500 mb-4">请先登录后修改设置</p>
        <Link href="/login" className="inline-block bg-amber-800 text-white px-5 py-2.5 rounded-lg text-sm hover:bg-amber-900 transition">
          去登录
        </Link>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);

    const form = e.target as HTMLFormElement;
    const el = (n: string) => form.elements.namedItem(n) as unknown as HTMLInputElement;
    const data = {
      username: el("username").value.trim(),
      nickname: (form.elements.namedItem("nickname") as unknown as HTMLInputElement).value.trim() || null,
      avatar: el("avatar").value.trim() || null,
      bio: (form.elements.namedItem("bio") as unknown as HTMLTextAreaElement).value.trim() || null,
    };

    try {
      const res = await fetch("/api/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "保存失败");
      }
      await update();
      setMessage({ type: "success", text: "设置已保存" });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-10">
      <h1 className="text-2xl md:text-4xl font-serif font-bold text-stone-800 mb-6">账号设置</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">用户名</label>
          <input
            name="username"
            required
            minLength={2}
            maxLength={50}
            defaultValue={profile?.username || ""}
            className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
          />
          <p className="text-xs text-stone-400 mt-1">2-50 个字符，修改后需唯一</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">UID（登录账号）</label>
          <input
            value={profile?.uid ? `#${profile.uid}` : "未分配"}
            disabled
            className="w-full px-3 py-2.5 border border-stone-200 rounded-lg text-sm bg-stone-50 text-stone-500 cursor-not-allowed font-mono"
          />
          <p className="text-xs text-stone-400 mt-1">使用 UID 号码登录</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">昵称</label>
          <input
            name="nickname"
            maxLength={50}
            defaultValue={profile?.nickname || profile?.username || ""}
            className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
          />
          <p className="text-xs text-stone-400 mt-1">论坛中显示的名称，留空则显示用户名</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">头像</label>
          <div className="flex items-center gap-3">
            <input
              name="avatar"
              defaultValue={profile?.avatar || ""}
              placeholder="https://..."
              className="flex-1 px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500"
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setUploading(true);
                const fd = new FormData();
                fd.append("file", file);
                try {
                  const res = await fetch("/api/upload", { method: "POST", body: fd });
                  const data = await res.json();
                  if (data.url) {
                    // Auto-save avatar immediately
                    const saveRes = await fetch("/api/user/profile", {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ avatar: data.url }),
                    });
                    if (saveRes.ok) {
                      const updated = await saveRes.json();
                      setProfile(updated);
                      // Sync the URL input field
                      const input = document.querySelector<HTMLInputElement>("input[name='avatar']");
                      if (input) input.value = data.url;
                      await update();
                      setMessage({ type: "success", text: "头像已更新" });
                    }
                  }
                } catch {
                  // ignore
                } finally {
                  setUploading(false);
                }
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="shrink-0 px-4 py-2.5 border border-stone-300 rounded-lg text-sm text-stone-600 hover:bg-stone-50 transition min-h-[44px]"
            >
              {uploading ? "上传中..." : "上传"}
            </button>
          </div>
          {profile?.avatar && (
            <div className="mt-2 flex items-center gap-2">
              <img src={profile.avatar} alt="" className="w-8 h-8 rounded-full object-cover" />
              <span className="text-xs text-stone-400">当前头像预览</span>
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">个人简介</label>
          <textarea
            name="bio"
            rows={3}
            maxLength={500}
            placeholder="介绍一下自己..."
            defaultValue={profile?.bio || ""}
            className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500 resize-y"
          />
        </div>

        {message && (
          <p className={`text-sm ${message.type === "success" ? "text-green-600" : "text-red-600"}`}>
            {message.text}
          </p>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="px-6 py-3 bg-amber-800 text-white rounded-lg text-sm font-medium hover:bg-amber-900 disabled:opacity-50 transition min-h-[44px]"
          >
            {saving ? "保存中..." : "保存设置"}
          </button>
        </div>
      </form>

      {/* Change Password */}
      <hr className="my-8 border-stone-200" />
      <h2 className="text-lg font-bold text-stone-800 mb-4">修改密码</h2>
      <ChangePasswordForm />
    </div>
  );
}

function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    if (newPassword !== confirmPassword) {
      setMessage({ type: "error", text: "两次密码不一致" });
      return;
    }

    setLoading(true);
    const res = await fetch("/api/user/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();
    setLoading(false);

    if (res.ok) {
      setMessage({ type: "success", text: "密码已修改" });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } else {
      setMessage({ type: "error", text: data.error || "修改失败" });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-md">
      <div>
        <label className="block text-sm font-medium text-stone-700 mb-1">当前密码</label>
        <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm" />
      </div>
      <div>
        <label className="block text-sm font-medium text-stone-700 mb-1">新密码</label>
        <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm" placeholder="至少8位，含字母和数字" />
      </div>
      <div>
        <label className="block text-sm font-medium text-stone-700 mb-1">确认新密码</label>
        <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={8} className="w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm" />
      </div>
      {message && (
        <p className={`text-sm ${message.type === "success" ? "text-green-600" : "text-red-600"}`}>{message.text}</p>
      )}
      <button type="submit" disabled={loading} className="px-6 py-3 border border-stone-300 text-stone-700 rounded-lg text-sm hover:bg-stone-50 disabled:opacity-50 transition min-h-[44px]">
        {loading ? "修改中..." : "修改密码"}
      </button>
    </form>
  );
}
