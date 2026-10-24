"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";

/**
 * 登录后回跳目标。只接受**站内绝对路径**：必须以单个 `/` 开头，
 * 拒绝 `//evil.com`（协议相对 URL）、`/\evil.com`（部分浏览器按 `//` 解析）
 * 和任何含 `:` 的值（`javascript:`、`https:`）。回跳参数来自 URL，
 * 不做这层校验就是开放重定向。
 */
function safeNextPath(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (raw.includes(":") || raw.includes("\\")) return "/";
  return raw;
}

export default function LoginPage() {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // 忘记密码：站内没有邮件通道，所以是「提交申请 → 管理员在后台重置」。
  const [forgot, setForgot] = useState(false);
  const [forgotNote, setForgotNote] = useState("");
  const [forgotPassword, setForgotPassword] = useState("");
  const [forgotRegistration, setForgotRegistration] = useState("");
  const [forgotLastLogin, setForgotLastLogin] = useState("");
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotMsg, setForgotMsg] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account.trim() || !forgotRegistration.trim() || !forgotLastLogin.trim()) {
      setForgotMsg("请填写账号与两个核验问题的答案");
      return;
    }
    setForgotBusy(true);
    setForgotMsg("");
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: account.trim(),
          registration: forgotRegistration.trim(),
          lastLogin: forgotLastLogin.trim(),
          email: forgotEmail.trim() || undefined,
          note: forgotNote.trim() || undefined,
          newPassword: forgotPassword || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setForgotMsg(data.error || "提交失败，请稍后再试");
        return;
      }
      setForgotMsg(data.message || "已收到你的密码重置申请，站长会尽快处理。");
      setForgotNote("");
      setForgotPassword("");
      setForgotRegistration("");
      setForgotLastLogin("");
    } catch {
      setForgotMsg("提交失败，请稍后再试");
    } finally {
      setForgotBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const result = await signIn("credentials", {
      email: account,
      password,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError("账号或密码不正确");
    } else {
      // Hard redirect: forces SessionProvider to re-init so useSession()
      // reflects the just-set JWT cookie. A soft router.push() leaves the
      // stale pre-login session cached → header still shows "登录/注册".
      // `next` 从 window 读取而非 useSearchParams()，与本仓库其它客户端页一致
      // （避免客户端组件 prerender 需要 Suspense 包裹）。
      window.location.href = safeNextPath(new URLSearchParams(window.location.search).get("next"));
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-amber-50 to-stone-100">
      <div className="w-full max-w-md p-5 md:p-8 bg-white rounded-2xl shadow-lg border border-amber-100 mx-4 md:mx-0">
        <div className="text-center mb-6 md:mb-8">
          <h1 className="text-2xl md:text-3xl font-bold" style={{ color: "#3d6b4e" }}>Puêr</h1>
          <p className="text-stone-500 mt-2 text-sm md:text-base">以茶会友，品鉴真味</p>
        </div>

        {forgot ? (
          <form onSubmit={handleForgot} className="space-y-5">
            <div>
              <h2 className="text-sm font-medium text-stone-700">忘记密码</h2>
              <p className="text-xs text-stone-500 mt-1 leading-relaxed">
                填账号，再回答两个关于你自己账号的问题。
                站长拿记录核对后就会批准 —— 你可以**自己定一个新密码**，
                不需要等站长把密码告诉你。申请结果会通过站内通知告诉你。
              </p>
            </div>

            {forgotMsg && (
              <div className="p-3 text-sm text-amber-800 bg-amber-50 rounded-lg border border-amber-200">
                {forgotMsg}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">账号</label>
              <input
                type="text"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
                placeholder="UID、用户名或邮箱"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                你大概是哪年哪月注册的？
              </label>
              <input
                type="text"
                value={forgotRegistration}
                onChange={(e) => setForgotRegistration(e.target.value)}
                className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
                placeholder="如 2026年5月"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                你最后一次登录大概是哪年哪月？
              </label>
              <input
                type="text"
                value={forgotLastLogin}
                onChange={(e) => setForgotLastLogin(e.target.value)}
                className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
                placeholder="如 2026年10月"
              />
              <p className="text-[0.7rem] text-stone-400 mt-1">
                记个大概就行，站长会跟记录核对
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                注册邮箱（填过的话）
              </label>
              <input
                type="email"
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
                autoComplete="email"
                className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
                placeholder="选填"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                新密码（至少 6 位）
              </label>
              <input
                type="password"
                value={forgotPassword}
                onChange={(e) => setForgotPassword(e.target.value)}
                autoComplete="new-password"
                className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
                placeholder="留空则由站长代设"
              />
              <p className="text-[0.7rem] text-stone-400 mt-1">
                只存哈希，站长也看不到明文。批准前不会生效。
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                补充说明（可选）
              </label>
              <textarea
                value={forgotNote}
                onChange={(e) => setForgotNote(e.target.value)}
                rows={2}
                maxLength={200}
                placeholder="怎么联系你、最近一次能登录是什么时候…"
                className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition resize-none"
              />
            </div>

            <button
              type="submit"
              disabled={forgotBusy}
              className="w-full py-2.5 bg-amber-800 hover:bg-amber-900 text-white rounded-lg font-medium transition disabled:opacity-50"
            >
              {forgotBusy ? "提交中..." : "提交重置申请"}
            </button>

            <button
              type="button"
              onClick={() => { setForgot(false); setForgotMsg(""); setError(""); }}
              className="w-full text-sm text-stone-500 hover:text-stone-700 transition"
            >
              返回登录
            </button>
          </form>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-5">
          {error && (
            <div className="p-3 text-sm text-red-700 bg-red-50 rounded-lg border border-red-200">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">账号</label>
            <input
              type="text"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              required
              className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
              placeholder="UID、用户名或邮箱"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
              placeholder="••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-amber-800 hover:bg-amber-900 text-white rounded-lg font-medium transition disabled:opacity-50"
          >
            {loading ? "登录中..." : "登录"}
          </button>

          <div className="text-center">
            <button
              type="button"
              onClick={() => { setForgot(true); setError(""); }}
              className="text-sm text-stone-500 hover:text-amber-800 transition"
            >
              忘记密码？
            </button>
          </div>
        </form>
        )}

        <p className="text-center text-sm text-stone-500 mt-6">
          还没有账号？{" "}
          <Link href="/register" className="text-amber-700 hover:text-amber-900 font-medium">
            注册
          </Link>
        </p>
      </div>
    </div>
  );
}
