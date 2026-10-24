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

  // 忘记密码：站内没有邮件通道，所以是「提交申请 → 管理员核对 → 用户自设密码」。
  const [forgot, setForgot] = useState(false);
  const [forgotNote, setForgotNote] = useState("");
  const [forgotRegistration, setForgotRegistration] = useState("");
  const [forgotLastLogin, setForgotLastLogin] = useState("");
  const [forgotRegion, setForgotRegion] = useState("");
  const [forgotArticles, setForgotArticles] = useState("");
  const [forgotComments, setForgotComments] = useState("");
  const [forgotUpvotes, setForgotUpvotes] = useState("");
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotMsg, setForgotMsg] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  // 申请状态：none（没申请过）/ pending（等待核对）/ approved（已通过）/ rejected（被驳回）
  const [forgotState, setForgotState] = useState<"none" | "pending" | "approved" | "rejected">("none");
  // 用户**当场定好的新密码** —— 站长核对通过后它就生效
  const [newPassword, setNewPassword] = useState("");
  const [newPassword2, setNewPassword2] = useState("");

  /**
   * 查这个账号有没有申请过重置、走到哪一步了。
   *
   * 账号不存在 / 从没申请过 → 服务端一律回 `none`，所以这里**不会**
   * 泄露「这个账号存不存在」。
   */
  const probeResetState = async (acc: string) => {
    const a = acc.trim();
    if (!a) return;
    try {
      const res = await fetch(`/api/auth/forgot-password?account=${encodeURIComponent(a)}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.state) setForgotState(data.state);
    } catch {
      // 查不到状态不影响提交 —— 提交时服务端会按真实状态处理
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account.trim()) {
      setForgotMsg("请填写账号");
      return;
    }
    if (newPassword !== newPassword2) {
      setForgotMsg("两次输入的密码不一样");
      return;
    }
    if (newPassword.length < 8 || !/[a-zA-Z]/.test(newPassword) || !/\d/.test(newPassword)) {
      setForgotMsg("密码至少 8 位，且要同时有字母和数字");
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
          region: forgotRegion.trim() || undefined,
          articles: forgotArticles.trim() || undefined,
          comments: forgotComments.trim() || undefined,
          upvotes: forgotUpvotes.trim() || undefined,
          email: forgotEmail.trim() || undefined,
          note: forgotNote.trim() || undefined,
          password: newPassword,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setForgotMsg(data.error || "提交失败，请稍后再试");
        return;
      }
      setForgotMsg(data.message || "已收到你的密码重置申请，站长会尽快处理。");
      if (data.state) setForgotState(data.state === "used" ? "approved" : data.state);
      if (data.reset) {
        // 密码已经改好了 —— 让他直接回登录页用新密码登录
        setNewPassword("");
        setNewPassword2("");
      }
      setForgotNote("");
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
                填账号，回答几个关于你自己账号的问题，再
                <strong className="text-stone-700">当场定一个新密码</strong>。
                站长核对通过后，你设的密码就生效 —— 直接用它登录，
                不用等谁把密码送到你手上。
              </p>
            </div>

            {/* 申请状态：查状态不会泄露账号存不存在（服务端对不存在的
                账号也回 none），只告诉你这个账号的重置走到哪一步了。 */}
            {forgotState === "approved" && (
              <div className="p-3 text-sm text-green-800 bg-green-50 rounded-lg border border-green-200">
                ✅ 你的申请已经通过了 —— 填下面的新密码就能改好。
                如果忘了当时设的密码，就把下面两个时间题按申请时填的内容再答一遍。
              </div>
            )}
            {forgotState === "pending" && (
              <div className="p-3 text-sm text-amber-800 bg-amber-50 rounded-lg border border-amber-200">
                ⏳ 你的申请正在等站长核对。核对通过后，你申请时设的新密码就会生效。
              </div>
            )}
            {forgotState === "rejected" && (
              <div className="p-3 text-sm text-red-700 bg-red-50 rounded-lg border border-red-200">
                上次的申请没有通过 —— 可以重新填一份提交。
              </div>
            )}

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
                onBlur={() => probeResetState(account)}
                className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
                placeholder="UID、用户名或邮箱"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                新密码（现在就定好，核对通过后即可用）
              </label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
                placeholder="至少8位，含字母和数字"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                再输一次
              </label>
              <input
                type="password"
                value={newPassword2}
                onChange={(e) => setNewPassword2(e.target.value)}
                autoComplete="new-password"
                className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
              />
            </div>

            {/* 核验题：输入框**不给提示** —— 格式不统一不是用户的错，
                填成什么样都行，站长拿记录判断是否接近。
                前两题（时间）也是「改已批准的密码」时的身份凭证。 */}
            {[
              { label: "你大概是哪年哪月注册的？", value: forgotRegistration, set: setForgotRegistration },
              { label: "你最后一次登录大概是哪年哪月？", value: forgotLastLogin, set: setForgotLastLogin },
              { label: "你注册时所在的省份 / 地区是？", value: forgotRegion, set: setForgotRegion },
              { label: "你大概发过多少篇文章？", value: forgotArticles, set: setForgotArticles },
              { label: "你大概发过多少条评论？", value: forgotComments, set: setForgotComments },
              { label: "你大概收到过多少个赞？", value: forgotUpvotes, set: setForgotUpvotes },
            ].map((q) => (
              <div key={q.label}>
                <label className="block text-sm font-medium text-stone-700 mb-1">
                  {q.label}
                </label>
                <input
                  type="text"
                  value={q.value}
                  onChange={(e) => q.set(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition"
                />
              </div>
            ))}

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
                补充说明（可选）
              </label>
              <textarea
                value={forgotNote}
                onChange={(e) => setForgotNote(e.target.value)}
                rows={2}
                maxLength={200}
                className="w-full px-4 py-2.5 rounded-lg border border-stone-300 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none transition resize-none"
              />
            </div>

            <button
              type="submit"
              disabled={forgotBusy}
              className="w-full py-2.5 bg-amber-800 hover:bg-amber-900 text-white rounded-lg font-medium transition disabled:opacity-50"
            >
              {forgotBusy
                ? "提交中..."
                : forgotState === "approved"
                  ? "设置新密码"
                  : "提交重置申请"}
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
